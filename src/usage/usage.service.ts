import { Injectable, Logger } from "@nestjs/common";
import { Database, type Tx } from "../core/db/database";
import { InvalidRequestError, UnknownMetricError, UsageLimitExceededError } from "../core/errors";
import { events } from "../core/events";
import { uuidV7 } from "../core/ids";
import { OutboxWriter } from "../core/outbox";
import { EntitlementsService, UPGRADE_URL } from "../entitlements/entitlements.service";
import type { EffectiveEntitlements } from "../entitlements/resolver";
import { type MetricRow, PlansRepository } from "../subscriptions/plans.repository";
import { GAUGE_PERIOD, monthBucket, UsageRepository } from "./usage.repository";

export interface UsageEventInput {
  metric: string;
  quantity?: number;
  idempotency_key?: string | null;
  properties?: Record<string, unknown> | null;
}

export interface UsageResult {
  metric: string;
  quantity: number;
  total: number;
  limit?: number | null;
  remaining?: number | null;
  within_limit?: boolean | null;
  /** True when an idempotency_key matched an earlier request: nothing was counted again. */
  deduplicated: boolean;
}

export interface UsageCheck {
  metric: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  within_limit: boolean;
  soft_limit: number | null;
  soft_limit_breached: boolean;
}

export interface UsageSummary {
  period: string;
  metrics: UsageCheck[];
}

/**
 * Usage metering (transliterated from the reference's `usage/service.py`).
 *
 * - `record`: metering never blocks — always succeeds (soft analytics path)
 * - `check`: read-only pre-flight against the effective limit
 * - `consume`: atomic increment + limit compare; a breach throws 402 and the
 *   caller's transaction (event + counter + idempotency reservation) rolls back
 * - `summary`: console meters
 *
 * Counter increments are one `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * under the counter's row lock, so concurrent consumers serialise on the row
 * and cannot overshoot undetected. Idempotency keys are reserved in
 * `usage_idempotency_keys` before the event is written: a retry blocks on the
 * primary key until the first request commits, then reads the stored result.
 * Gauges are levels in a fixed bucket; `record`/`consume` reject gauge metrics.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly db: Database,
    private readonly usage: UsageRepository,
    private readonly plans: PlansRepository,
    private readonly entitlements: EntitlementsService,
    private readonly outbox: OutboxWriter,
  ) {}

  // ── Pure limit arithmetic ───────────────────────────────────────────────────

  /** Limit check for an already-resolved entitlement set (`UsageCheckOut`). */
  static checkAgainst(entitlements: EffectiveEntitlements, metric: string, used: number, quantity = 1): UsageCheck {
    const limit = entitlements.limit(metric);
    const value = limit ? limit.value : null;
    const soft = limit && value && limit.softLimitRatio ? Math.trunc(value * limit.softLimitRatio) : null;
    return {
      metric,
      used,
      limit: value,
      remaining: value !== null ? value - used : null,
      within_limit: value === null || used + quantity <= value,
      soft_limit: soft,
      soft_limit_breached: soft !== null && used >= soft,
    };
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  async currentTotal(tx: Tx, organizationId: string, metric: string, period?: string): Promise<number> {
    return this.usage.currentTotal(tx, organizationId, metric, period ?? (await this.periodFor(tx, metric)));
  }

  /** `[{metric, used}]` for the month (gauges always included). */
  summary(tx: Tx, organizationId: string, period?: string): Promise<{ metric: string; used: number }[]> {
    return this.usage.summaryRows(tx, organizationId, period ?? monthBucket(new Date()));
  }

  /** One entitlement resolution for the whole summary (not one per metric). */
  async summaryOut(tx: Tx, organizationId: string, period?: string): Promise<UsageSummary> {
    const bucket = period ?? monthBucket(new Date());
    const rows = await this.summary(tx, organizationId, bucket);
    const entitlements = await this.entitlements.effectiveForOrg(tx, organizationId);
    return { period: bucket, metrics: rows.map((row) => UsageService.checkAgainst(entitlements, row.metric, Number(row.used))) };
  }

  async check(tx: Tx, organizationId: string, metric: string, quantity = 1): Promise<UsageCheck> {
    const entitlements = await this.entitlements.effectiveForOrg(tx, organizationId);
    const used = await this.currentTotal(tx, organizationId, metric);
    return UsageService.checkAgainst(entitlements, metric, used, quantity);
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  /** Record a usage event. Metering never blocks; no limit enforcement. */
  async record(tx: Tx, organizationId: string, metric: string, input: UsageEventInput & { occurredAt?: Date } = { metric }): Promise<UsageResult> {
    await this.assertCounterMetric(tx, metric);
    const quantity = input.quantity ?? 1;
    const key = input.idempotency_key ?? null;
    if (key !== null && !(await this.usage.reserveIdempotency(tx, organizationId, key, metric, quantity))) {
      return this.replay(tx, organizationId, key);
    }
    const now = input.occurredAt ?? new Date();
    const eventId = await this.usage.insertEvent(tx, { organizationId, metric, quantity, occurredAt: now, idempotencyKey: key, properties: input.properties ?? {} });
    const total = await this.usage.incrementCounter(tx, organizationId, metric, monthBucket(now), quantity, now);
    await this.maybeEmitSoftLimit(tx, organizationId, metric, total);
    if (key !== null) await this.usage.settleIdempotency(tx, organizationId, key, eventId, total);
    return { metric, quantity, total, deduplicated: false };
  }

  /** Record + enforce. A breach throws `UsageLimitExceededError` (402); the caller's transaction rolls back together. */
  async consume(tx: Tx, organizationId: string, metric: string, input: UsageEventInput = { metric }): Promise<UsageResult> {
    await this.assertCounterMetric(tx, metric);
    const quantity = input.quantity ?? 1;
    const key = input.idempotency_key ?? null;
    const now = new Date();
    const entitlements = await this.entitlements.effectiveForOrg(tx, organizationId);
    const limitValue = entitlements.limit(metric)?.value ?? null;

    if (key !== null && !(await this.usage.reserveIdempotency(tx, organizationId, key, metric, quantity))) {
      const replay = await this.replay(tx, organizationId, key);
      return {
        ...replay,
        limit: limitValue,
        remaining: limitValue !== null ? limitValue - replay.total : null,
        within_limit: limitValue === null || replay.total <= limitValue,
      };
    }

    const eventId = await this.usage.insertEvent(tx, { organizationId, metric, quantity, occurredAt: now, idempotencyKey: key, properties: input.properties ?? {} });
    const total = await this.usage.incrementCounter(tx, organizationId, metric, monthBucket(now), quantity, now);
    if (limitValue !== null && total > limitValue) {
      throw new UsageLimitExceededError(`${metric} limit exceeded (${limitValue}/period)`, {
        metric,
        limit: limitValue,
        used: total - quantity,
        attempted: quantity,
        upgrade_url: UPGRADE_URL,
      });
    }
    await this.maybeEmitSoftLimit(tx, organizationId, metric, total);
    if (limitValue !== null && total >= limitValue) {
      await this.outbox.append(tx, {
        eventType: events.USAGE_HARD_LIMIT_REACHED,
        aggregateType: "usage",
        aggregateId: uuidV7(),
        organizationId,
        payload: { metric, limit: limitValue, total },
      });
    }
    if (key !== null) await this.usage.settleIdempotency(tx, organizationId, key, eventId, total);
    return {
      metric,
      quantity,
      total,
      limit: limitValue,
      remaining: limitValue !== null ? limitValue - total : null,
      within_limit: limitValue === null || total <= limitValue,
      deduplicated: false,
    };
  }

  /** Consume a batch atomically: the first breach throws and the caller's transaction rolls back every event. */
  async consumeMany(tx: Tx, organizationId: string, inputs: UsageEventInput[]): Promise<UsageResult[]> {
    const results: UsageResult[] = [];
    for (const input of inputs) results.push(await this.consume(tx, organizationId, input.metric, input));
    return results;
  }

  // ── Gauges ──────────────────────────────────────────────────────────────────

  /** Set a gauge to an absolute level (seats in use, projects, bytes stored). A sync, never refused. */
  async setGauge(tx: Tx, organizationId: string, metric: string, value: number): Promise<UsageResult> {
    await this.assertGaugeMetric(tx, metric);
    const level = Math.max(Math.trunc(value), 0);
    await this.usage.setGauge(tx, organizationId, metric, level);
    return this.gaugeResult(tx, organizationId, metric, level);
  }

  /**
   * Move a gauge by `delta` (never below zero). A positive delta is capacity-
   * checked first — 402 with upgrade hints when it would exceed the limit —
   * unless `enforce` is false.
   */
  async adjustGauge(tx: Tx, organizationId: string, metric: string, delta: number, enforce = true): Promise<UsageResult> {
    await this.assertGaugeMetric(tx, metric);
    if (enforce && delta > 0) {
      const current = await this.currentTotal(tx, organizationId, metric, GAUGE_PERIOD);
      await this.ensureGaugeCapacity(tx, organizationId, metric, current, delta);
    }
    const level = await this.usage.adjustGauge(tx, organizationId, metric, Math.trunc(delta));
    return this.gaugeResult(tx, organizationId, metric, level);
  }

  /** Gauge (capacity) check — e.g. seats: 402 when `current + adding` exceeds the limit. */
  async ensureGaugeCapacity(tx: Tx, organizationId: string, metric: string, current: number, adding = 1): Promise<void> {
    await this.assertGaugeMetric(tx, metric);
    const value = (await this.entitlements.effectiveForOrg(tx, organizationId)).limit(metric)?.value ?? null;
    if (value !== null && current + adding > value) {
      throw new UsageLimitExceededError(`${metric} limit reached (${value})`, { metric, limit: value, used: current, upgrade_url: UPGRADE_URL });
    }
  }

  // ── Transaction-owning entrypoints (HTTP layer) ─────────────────────────────

  recordEvents(organizationId: string, inputs: UsageEventInput[]): Promise<UsageResult[]> {
    return this.db.transaction(async (tx) => {
      const results: UsageResult[] = [];
      for (const input of inputs) results.push(await this.record(tx, organizationId, input.metric, input));
      return results;
    });
  }

  consumeOne(organizationId: string, input: UsageEventInput): Promise<UsageResult> {
    return this.db.transaction((tx) => this.consume(tx, organizationId, input.metric, input));
  }

  consumeBatch(organizationId: string, inputs: UsageEventInput[]): Promise<UsageResult[]> {
    return this.db.transaction((tx) => this.consumeMany(tx, organizationId, inputs));
  }

  gauge(organizationId: string, metric: string, input: { value?: number | null; delta?: number | null }): Promise<UsageResult> {
    return this.db.transaction((tx) =>
      input.value != null ? this.setGauge(tx, organizationId, metric, input.value) : this.adjustGauge(tx, organizationId, metric, input.delta ?? 0),
    );
  }

  checkUsage(organizationId: string, metric: string, quantity = 1): Promise<UsageCheck> {
    return this.db.transaction((tx) => this.check(tx, organizationId, metric, quantity));
  }

  usageSummary(organizationId: string, period?: string): Promise<UsageSummary> {
    return this.db.transaction((tx) => this.summaryOut(tx, organizationId, period));
  }

  /**
   * Count one `api_requests` unit for a key-authenticated call — best effort.
   * `record` never blocks, and the metering runs in its own transaction so a
   * failure here (unsynced catalog, partition gap) is logged and never fails
   * the request it accompanies (the reference's savepoint).
   */
  async meterApiKeyRequest(organizationId: string): Promise<void> {
    try {
      await this.db.transaction((tx) => this.record(tx, organizationId, "api_requests", { metric: "api_requests", quantity: 1 }));
    } catch (error) {
      this.logger.warn(`api key metering failed for org ${organizationId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async metric(tx: Tx, key: string): Promise<MetricRow> {
    const row = await this.plans.findMetric(tx, key);
    if (!row) throw new UnknownMetricError(`Unknown usage metric '${key}'`, { metric: key });
    return row;
  }

  private async assertCounterMetric(tx: Tx, metric: string): Promise<void> {
    const row = await this.metric(tx, metric);
    if (row.kind === "gauge") {
      throw new InvalidRequestError(`'${metric}' is a gauge (a level, not a flow): set it with POST /usage/gauge`, { metric, kind: "gauge" });
    }
  }

  private async assertGaugeMetric(tx: Tx, metric: string): Promise<void> {
    const row = await this.metric(tx, metric);
    if (row.kind !== "gauge") {
      throw new InvalidRequestError(`'${metric}' is a counter: meter it with /usage/events or /usage/consume`, { metric, kind: row.kind });
    }
  }

  private async periodFor(tx: Tx, metric: string): Promise<string> {
    return (await this.metric(tx, metric)).kind === "gauge" ? GAUGE_PERIOD : monthBucket(new Date());
  }

  private async replay(tx: Tx, organizationId: string, key: string): Promise<UsageResult> {
    const row = await this.usage.replayIdempotent(tx, organizationId, key);
    this.logger.log(`usage deduplicated org=${organizationId} idempotency_key=${key} metric=${row.metric}`);
    return { metric: row.metric, quantity: Number(row.quantity), total: Number(row.total_after ?? 0), deduplicated: true };
  }

  private async gaugeResult(tx: Tx, organizationId: string, metric: string, level: number): Promise<UsageResult> {
    const value = (await this.entitlements.effectiveForOrg(tx, organizationId)).limit(metric)?.value ?? null;
    return {
      metric,
      quantity: level,
      total: level,
      limit: value,
      remaining: value !== null ? value - level : null,
      within_limit: value === null || level <= value,
      deduplicated: false,
    };
  }

  /** Emit usage.soft_limit_reached exactly once per metric per period. */
  private async maybeEmitSoftLimit(tx: Tx, organizationId: string, metric: string, total: number): Promise<void> {
    const limit = (await this.entitlements.effectiveForOrg(tx, organizationId)).limit(metric);
    if (!limit || limit.value === null || !limit.softLimitRatio) return;
    const threshold = Math.trunc(limit.value * limit.softLimitRatio);
    if (total < threshold) return;
    if (!(await this.usage.markSoftLimitNotified(tx, organizationId, metric, monthBucket(new Date())))) return;
    await this.outbox.append(tx, {
      eventType: events.USAGE_SOFT_LIMIT_REACHED,
      aggregateType: "usage",
      aggregateId: uuidV7(),
      organizationId,
      payload: { organization_id: organizationId, metric, threshold, total, limit: limit.value },
    });
  }
}
