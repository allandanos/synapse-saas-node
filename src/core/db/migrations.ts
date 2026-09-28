import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../config";

/**
 * Raw-SQL migration runner: applies `migrations/*.sql` once, in filename
 * order, each file in its own transaction, tracked in `schema_migrations`.
 * The baseline is `contracts/schema-v1.sql` verbatim; later reference
 * migrations are mirrored as plain SQL (ADR 0012 §4) — never generated DDL.
 */
export const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");

const MIGRATION_LOCK_KEY = 7_263_010; // arbitrary, shared by every instance of this service

@Injectable()
export class MigrationRunner {
  private readonly logger = new Logger(MigrationRunner.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async run(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
    const applied: string[] = [];
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const done = new Set(
        (await client.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename),
      );
      const files = readdirSync(dir)
        .filter((name) => name.endsWith(".sql"))
        .sort();
      for (const name of files) {
        if (done.has(name)) continue;
        const sql = readFileSync(join(dir, name), "utf8");
        await client.query("BEGIN");
        try {
          // pg_dump order: SQL-language functions precede the tables they read;
          // like the dump header, skip body validation while the file applies.
          await client.query("SET LOCAL check_function_bodies = false");
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [name]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        applied.push(name);
        this.logger.log(`applied migration ${name}`);
      }
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } finally {
      // A dump can carry session-level SETs; never let them re-enter the pool.
      client.release(true);
    }
    return applied;
  }
}
