import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";

export interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  organization_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  audience: string;
  attempts: number;
}

/** 5s, 30s, 2m, 10m, 30m, 1h, 1h, 1h — then the event is dead-lettered. */
export const OUTBOX_BACKOFF_SECONDS: readonly number[] = [5, 30, 120, 600, 1800, 3600, 3600, 3600];
export const OUTBOX_MAX_ATTEMPTS = 8;

const COLUMNS = "id, aggregate_type, aggregate_id, organization_id, event_type, payload, audience, attempts";

@Injectable()
export class OutboxRepository {
  /** Claim pending events whose backoff has elapsed; SKIP LOCKED so workers never double-publish. */
  claimPending(tx: Tx, limit: number): Promise<OutboxRow[]> {
    return tx.rows<OutboxRow>(
      `SELECT ${COLUMNS} FROM outbox_events
       WHERE published_at IS NULL AND dead_at IS NULL AND next_attempt_at <= now()
       ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
  }

  async markPublished(tx: Tx, id: string): Promise<void> {
    await tx.query(`UPDATE outbox_events SET published_at = now() WHERE id = $1`, [id]);
  }

  /**
   * Retry bookkeeping for one failed event. After `OUTBOX_MAX_ATTEMPTS` the
   * row is dead-lettered so a single poison event cannot pin the batch forever.
   */
  async recordFailure(tx: Tx, row: OutboxRow, error: string): Promise<{ attempts: number; dead: boolean }> {
    const attempts = row.attempts + 1;
    const dead = attempts >= OUTBOX_MAX_ATTEMPTS;
    const backoff = OUTBOX_BACKOFF_SECONDS[Math.min(attempts - 1, OUTBOX_BACKOFF_SECONDS.length - 1)] as number;
    await tx.query(
      dead
        ? `UPDATE outbox_events SET attempts = $2, last_error = $3, dead_at = now() WHERE id = $1`
        : `UPDATE outbox_events SET attempts = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
      dead ? [row.id, attempts, error.slice(0, 1000)] : [row.id, attempts, error.slice(0, 1000), backoff],
    );
    return { attempts, dead };
  }
}
