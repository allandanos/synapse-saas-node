import { Injectable } from "@nestjs/common";
import type { Tx } from "../../core/db/database";
import { newUuid } from "../../core/ids";

/**
 * `provider_webhook_events` — the idempotency ledger. `(provider,
 * provider_event_id)` is unique, so a replayed delivery inserts nothing and
 * the request answers 200 without re-applying anything.
 */
@Injectable()
export class WebhookLedgerRepository {
  /** The new row's id, or undefined when this event was already recorded. */
  async claim(tx: Tx, provider: string, providerEventId: string, eventType: string): Promise<string | undefined> {
    const row = await tx.one<{ id: string }>(
      `INSERT INTO provider_webhook_events (id, provider, provider_event_id, event_type)
       VALUES ($1, $2, $3, $4) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
      [newUuid(), provider, providerEventId, eventType],
    );
    return row?.id;
  }

  async markProcessed(tx: Tx, id: string, error: string | null): Promise<void> {
    await tx.query(`UPDATE provider_webhook_events SET processed_at = now(), error = $2 WHERE id = $1`, [id, error]);
  }
}
