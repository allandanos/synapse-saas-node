import { Inject, Injectable, Logger } from "@nestjs/common";
import { InvoicingService } from "../billing/invoicing/invoicing.service";
import { locallyBilledProviderNames } from "../billing/providers";
import { SETTINGS, type Settings } from "../core/config";
import { Database, type Tx } from "../core/db/database";
import { AUDIENCE_PUBLIC, events } from "../core/events";
import { uuidV7 } from "../core/ids";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { NotificationHandlers } from "../notifications/handlers";
import { intervalMs } from "../subscriptions/subscriptions.service";
import { SubscriptionsRepository } from "../subscriptions/subscriptions.repository";
import { WebhookDeliveriesRepository } from "../webhooks/deliveries.repository";
import { WebhookDeliveryService } from "../webhooks/delivery.service";
import { AdvisoryLock } from "./advisory-lock";
import { OutboxRepository, type OutboxRow } from "./outbox.repository";

export const JOB_NAMES = [
  "dispatch_outbox",
  "deliver_webhooks",
  "rollup_usage",
  "expire_entitlements",
  "advance_recurring_billing",
  "ensure_partitions",
  "purge_expired",
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export const OUTBOX_BATCH = 20;
export const DELIVERY_BATCH = 20;
export const RENEWAL_BATCH = 100;
export const PARTITION_MONTHS_AHEAD = 3;

export const IDEMPOTENCY_RETENTION_DAYS = 90;
export const DELIVERY_RETENTION_DAYS = 30;
/** The failure audit trail outlives routine rows. */
export const EXHAUSTED_DELIVERY_RETENTION_DAYS = 90;
export const OUTBOX_RETENTION_DAYS = 7;

/**
 * The background jobs that keep the platform self-running. Each one is a
 * plain method returning a count, so the scheduler, `pnpm jobs:run-once` and
 * the tests all drive exactly the same code.
 *
 * Jobs are cross-tenant by nature: every transaction opens with
 * `tx.bindPlatform()` so RLS policies admit every row (a no-op unless
 * `SYNAPSE_TENANT_ISOLATION=app_and_rls`). Rows are claimed with
 * `FOR UPDATE SKIP LOCKED`, and the tick itself is guarded by an advisory
 * lock — no new tables, no external queue.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly db: Database,
    private readonly lock: AdvisoryLock,
    private readonly outbox: OutboxRepository,
    private readonly deliveries: WebhookDeliveriesRepository,
    private readonly delivery: WebhookDeliveryService,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly invoicing: InvoicingService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationHandlers,
  ) {}

  /** Run one job by name (`jobs run-once`, tests, a scheduler-triggered container). */
  run(name: JobName): Promise<number> {
    switch (name) {
      case "dispatch_outbox":
        return this.dispatchOutbox();
      case "deliver_webhooks":
        return this.deliverWebhooks();
      case "rollup_usage":
        return this.rollupUsage();
      case "expire_entitlements":
        return this.expireEntitlements();
      case "advance_recurring_billing":
        return this.advanceRecurringBilling();
      case "ensure_partitions":
        return this.ensurePartitions();
      case "purge_expired":
        return this.purgeExpired();
    }
  }

  // ── Outbox → webhook deliveries ───────────────────────────────────────────

  /**
   * Drain the outbox: fan public events out to each org's active endpoints,
   * mark them published, then run the in-process consumers. Consumers run only
   * after the events are durably committed, so a crash or retry can never send
   * the same invite or invoice twice.
   */
  dispatchOutbox(): Promise<number> {
    return this.lock.run(
      "dispatch_outbox",
      async () => {
        const published = await this.db.transaction(async (tx) => {
          await tx.bindPlatform();
          const rows = await this.outbox.claimPending(tx, OUTBOX_BATCH);
          const done: OutboxRow[] = [];
          for (const row of rows) {
            // A savepoint per event: one bad row must not roll the batch back.
            await tx.query("SAVEPOINT outbox_event");
            try {
              await this.fanOut(tx, row);
              await this.outbox.markPublished(tx, row.id);
              await tx.query("RELEASE SAVEPOINT outbox_event");
              done.push(row);
            } catch (error) {
              await tx.query("ROLLBACK TO SAVEPOINT outbox_event");
              const message = error instanceof Error ? error.message : String(error);
              const { attempts, dead } = await this.outbox.recordFailure(tx, row, message);
              if (dead) this.logger.error(`outbox event dead-lettered id=${row.id} type=${row.event_type} attempts=${String(attempts)}: ${message}`);
              else this.logger.warn(`outbox event failed id=${row.id} type=${row.event_type} attempts=${String(attempts)}: ${message}`);
            }
          }
          return done;
        });

        // Post-commit consumers. Best effort and logged; milestone 7 adds the
        // OpenFGA tuple sync alongside notifications.
        for (const row of published) {
          try {
            await this.notifications.handle(row.event_type, row.payload);
          } catch (error) {
            this.logger.warn(`internal consumer failed type=${row.event_type}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return published.length;
      },
      0,
    );
  }

  /** Public events fan out; internal ones (tokens, reset links, invoice email) never leave the process. */
  private async fanOut(tx: Tx, row: OutboxRow): Promise<void> {
    if (row.audience !== AUDIENCE_PUBLIC || row.organization_id === null) return;
    const endpoints = await this.deliveries.activeEndpointsFor(tx, row.organization_id, row.event_type);
    for (const endpoint of endpoints) {
      await this.deliveries.enqueue(tx, {
        endpointId: endpoint.id,
        organizationId: row.organization_id,
        outboxEventId: row.id,
        eventType: row.event_type,
        payload: row.payload,
      });
    }
  }

  /** POST the deliveries whose backoff has elapsed. */
  deliverWebhooks(): Promise<number> {
    return this.lock.run(
      "deliver_webhooks",
      () =>
        this.db.transaction(async (tx) => {
          await tx.bindPlatform();
          const due = await this.deliveries.claimDue(tx, DELIVERY_BATCH);
          let delivered = 0;
          for (const id of due) if (await this.delivery.deliver(tx, id)) delivered += 1;
          return delivered;
        }),
      0,
    );
  }

  // ── Usage + entitlements ──────────────────────────────────────────────────

  /** Hourly drift correction: rebuild the current period's counters from the events. */
  rollupUsage(): Promise<number> {
    return this.lock.run(
      "rollup_usage",
      () =>
        this.db.transaction(async (tx) => {
          await tx.bindPlatform();
          await tx.query(
            `INSERT INTO usage_counters (organization_id, metric, period_start, quantity_total, last_event_at)
             SELECT organization_id, metric, date_trunc('month', occurred_at)::date, SUM(quantity), MAX(occurred_at)
             FROM usage_events WHERE occurred_at >= date_trunc('month', now())
             GROUP BY organization_id, metric, date_trunc('month', occurred_at)::date
             ON CONFLICT (organization_id, metric, period_start)
             DO UPDATE SET quantity_total = EXCLUDED.quantity_total, last_event_at = EXCLUDED.last_event_at`,
          );
          return 1;
        }),
      0,
    );
  }

  /** Mark lapsed grants revoked so entitlements stop resolving them. */
  expireEntitlements(): Promise<number> {
    return this.lock.run(
      "expire_entitlements",
      async () => {
        const touched = await this.db.transaction(async (tx) => {
          await tx.bindPlatform();
          const rows = await tx.rows<{ id: string; organization_id: string; feature_key: string }>(
            `UPDATE entitlements SET revoked_at = now()
             WHERE revoked_at IS NULL AND ends_at IS NOT NULL AND ends_at <= now()
             RETURNING id, organization_id, feature_key`,
          );
          for (const row of rows) {
            await tx.query(
              `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, organization_id, event_type, payload, audience, attempts)
               VALUES ($1, 'entitlement', $2, $3, $4, $5::jsonb, 'public', 0)`,
              [uuidV7(), row.id, row.organization_id, events.ENTITLEMENT_EXPIRED, JSON.stringify({ feature_key: row.feature_key })],
            );
          }
          return rows;
        });
        // Invalidate AFTER the commit so no reader caches the pre-revocation rows.
        for (const organizationId of new Set(touched.map((row) => row.organization_id))) this.entitlements.invalidate(organizationId);
        return touched.length;
      },
      0,
    );
  }

  // ── Recurring billing ─────────────────────────────────────────────────────

  /**
   * Renew the subscriptions WE bill: invoice the period that just ended, then
   * roll it forward. Applies to every provider without `recurring_hosted` —
   * hosted providers renew on their side and report through webhooks. Rows are
   * claimed SKIP LOCKED and each renewal is its own savepoint, so one bad
   * subscription cannot block the batch. Invoices go through the invoicing
   * engine (lines, numbering, overage, email), never an inline INSERT.
   */
  advanceRecurringBilling(): Promise<number> {
    return this.lock.run(
      "advance_recurring_billing",
      () =>
        this.db.transaction(async (tx) => {
          await tx.bindPlatform();
          const rows = await tx.rows<{ id: string }>(
            `SELECT id FROM subscriptions
             WHERE status = 'active' AND current_period_end <= now() AND cancel_at_period_end = false
               AND (provider IS NULL OR provider = ANY($1::text[]))
             ORDER BY current_period_end LIMIT $2 FOR UPDATE SKIP LOCKED`,
            [locallyBilledProviderNames(), RENEWAL_BATCH],
          );
          let renewed = 0;
          for (const { id } of rows) {
            await tx.query("SAVEPOINT renewal");
            try {
              await this.renewLocallyBilled(tx, id);
              await tx.query("RELEASE SAVEPOINT renewal");
              renewed += 1;
            } catch (error) {
              await tx.query("ROLLBACK TO SAVEPOINT renewal");
              this.logger.error(`recurring billing failed subscription=${id}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          return renewed;
        }),
      0,
    );
  }

  /** Bill the period that just ended (in arrears), then roll the period forward. */
  private async renewLocallyBilled(tx: Tx, subscriptionId: string): Promise<void> {
    const subscription = await this.subscriptions.findById(tx, subscriptionId);
    if (!subscription) return;
    const snapshot = subscription.plan_snapshot;
    const price = Number(snapshot.price_cents ?? 0);
    if (price > 0 || subscription.pending_adjustments.length > 0) {
      const endedStart = subscription.current_period_start;
      const period = `${String(endedStart.getUTCFullYear())}-${String(endedStart.getUTCMonth() + 1).padStart(2, "0")}-01`;
      const invoice = await this.invoicing.draftForOrganization(tx, subscription.organization_id, { period });
      if (invoice.status === "draft") await this.invoicing.finalize(tx, invoice.id, subscription.organization_id);
    }
    const start = subscription.current_period_end;
    await this.subscriptions.update(tx, subscription.id, {
      current_period_start: start,
      current_period_end: new Date(start.getTime() + intervalMs(String(snapshot.interval ?? "month"))),
    });
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  /**
   * Pre-create `usage_events` partitions for the next PARTITION_MONTHS_AHEAD
   * months. A lapsed run is survivable: rows for a month with no partition
   * land in `usage_events_default` instead of failing every insert.
   */
  ensurePartitions(): Promise<number> {
    return this.lock.run(
      "ensure_partitions",
      () =>
        this.db.transaction(async (tx) => {
          await tx.bindPlatform();
          await tx.query(
            `DO $$
             DECLARE i INT; p DATE;
             BEGIN
               FOR i IN 0..${String(PARTITION_MONTHS_AHEAD)} LOOP
                 p := (date_trunc('month', now()) + make_interval(months => i))::date;
                 EXECUTE format(
                   'CREATE TABLE IF NOT EXISTS usage_events_y%sm%s PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
                   to_char(p, 'YYYY'), to_char(p, 'MM'), p, p + INTERVAL '1 month');
               END LOOP;
             END $$;`,
          );
          return PARTITION_MONTHS_AHEAD + 1;
        }),
      0,
    );
  }

  /**
   * Retention: delivered/failed deliveries (30d), exhausted ones (90d — they
   * are the failure audit trail), published outbox rows (7d), spent usage
   * idempotency keys (90d), audit logs past `SYNAPSE_AUDIT_RETENTION_DAYS`.
   */
  purgeExpired(): Promise<number> {
    return this.lock.run(
      "purge_expired",
      () =>
        this.db.transaction(async (tx) => {
          await tx.bindPlatform();
          let purged = 0;
          const purge = async (sql: string, params: unknown[]): Promise<void> => {
            purged += (await tx.query(sql, params)).rowCount ?? 0;
          };
          await purge(`DELETE FROM webhook_deliveries WHERE status <> 'exhausted' AND created_at < now() - make_interval(days => $1)`, [DELIVERY_RETENTION_DAYS]);
          await purge(`DELETE FROM webhook_deliveries WHERE status = 'exhausted' AND created_at < now() - make_interval(days => $1)`, [
            EXHAUSTED_DELIVERY_RETENTION_DAYS,
          ]);
          await purge(`DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at < now() - make_interval(days => $1)`, [OUTBOX_RETENTION_DAYS]);
          await purge(`DELETE FROM audit_logs WHERE created_at < now() - make_interval(days => $1)`, [this.settings.SYNAPSE_AUDIT_RETENTION_DAYS]);
          await purge(`DELETE FROM usage_idempotency_keys WHERE created_at < now() - make_interval(days => $1)`, [IDEMPOTENCY_RETENTION_DAYS]);
          return purged;
        }),
      0,
    );
  }
}
