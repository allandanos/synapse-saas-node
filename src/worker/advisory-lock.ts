import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../core/config";

/**
 * Job coordination without a new table: each tick takes
 * `pg_try_advisory_lock(hashtext('job:<name>'))` on a dedicated connection and
 * skips when another worker already holds it. Session-scoped, so the lock
 * spans the job's own transactions; rows inside are still claimed with
 * `FOR UPDATE SKIP LOCKED` so several workers can share one queue safely.
 */
@Injectable()
export class AdvisoryLock {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Run `fn` under the job's lock, or return `skipped` when the lock is held. */
  async run<T>(job: string, fn: () => Promise<T>, skipped: T): Promise<T> {
    const key = `job:${job}`;
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [key]);
      if (rows[0]?.locked !== true) return skipped;
      try {
        return await fn();
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      }
    } finally {
      client.release();
    }
  }
}
