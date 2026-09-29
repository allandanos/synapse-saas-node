import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { PG_POOL, SETTINGS, type Settings } from "../config";
import { RequestContext } from "../request-context";

/**
 * Database access: one transaction per unit of work, owned by the service
 * that performs it (ADR 0012 §5 — no commit-before-send middleware).
 *
 * Row-level security GUCs (`app.current_user`, `app.current_tenant`,
 * `app.rls_platform`) are transaction-local (`set_config(..., true)`), so each
 * transaction primes them from the request context at BEGIN, and a service
 * may bind a tenant mid-transaction (org creation, invite acceptance) before
 * the first tenant-scoped statement. Every binding is a no-op unless
 * SYNAPSE_TENANT_ISOLATION=app_and_rls.
 */
/** What `Tx.deferBump` needs of a cache — kept structural so `core/db` never imports `core/cache`. */
export interface Bumpable {
  readonly namespace: string;
  bump(key: string): Promise<number>;
}

export class Tx {
  private readonly postCommit: { key: string; run: () => Promise<unknown> }[] = [];

  constructor(
    private readonly client: PoolClient,
    private readonly rlsEnabled: boolean,
  ) {}

  /**
   * Queue `cache.bump(key)` to run once this transaction has COMMITted.
   *
   * Bumping inside the transaction lets a concurrent reader recompute from
   * the pre-commit rows and cache them under the NEW version — stale for a
   * full TTL after the change. Deferring closes that window
   * (`core/cache.py::defer_bump`). De-duplicated; dropped on rollback.
   */
  deferBump(cache: Bumpable, key: string): void {
    this.afterCommit(`bump:${cache.namespace}:${key}`, () => cache.bump(key));
  }

  /**
   * Queue any other side effect that must not happen until the rows are
   * durable. De-duplicated by `key`; dropped on rollback; a failure is the
   * caller's to survive (it is logged, never rethrown).
   */
  afterCommit(key: string, run: () => Promise<unknown>): void {
    if (this.postCommit.some((entry) => entry.key === key)) return;
    this.postCommit.push({ key, run });
  }

  /** Run the queued side effects. `Database.transaction` calls this after COMMIT. */
  async flushPostCommit(onError?: (key: string, error: unknown) => void): Promise<number> {
    const pending = this.postCommit.splice(0, this.postCommit.length);
    for (const { key, run } of pending) {
      try {
        await run();
      } catch (error) {
        onError?.(key, error);
      }
    }
    return pending.length;
  }

  discardPostCommit(): void {
    this.postCommit.length = 0;
  }

  query<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<R>> {
    return this.client.query<R>(text, params);
  }

  async rows<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> {
    return (await this.query<R>(text, params)).rows;
  }

  async one<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<R | undefined> {
    return (await this.query<R>(text, params)).rows[0];
  }

  /** Bind the transaction to one tenant. Call before the first tenant-scoped query. */
  bindTenant(organizationId: string): Promise<void> {
    return this.setGuc("app.current_tenant", organizationId);
  }

  /** Bind the authenticated user so their own memberships are readable pre-tenant. */
  bindUser(userId: string): Promise<void> {
    return this.setGuc("app.current_user", userId);
  }

  /** Platform-admin scope: policies admit every row for this transaction. */
  bindPlatform(): Promise<void> {
    return this.setGuc("app.rls_platform", "on");
  }

  private async setGuc(name: string, value: string): Promise<void> {
    if (!this.rlsEnabled) return;
    await this.client.query("SELECT set_config($1, $2, true)", [name, value]);
  }
}

export class RoleIsolationMismatchError extends Error {}

@Injectable()
export class Database {
  private readonly logger = new Logger(Database.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly context: RequestContext,
  ) {}

  /** Run `fn` in one transaction primed with the request's RLS bindings; commit on success. */
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx = new Tx(client, this.settings.rlsEnabled);
    let broken = false;
    let committed = false;
    try {
      await client.query("BEGIN");
      await this.prime(tx);
      const result = await fn(tx);
      await client.query("COMMIT");
      committed = true;
      // Cache invalidation (and any other post-commit effect) belongs after
      // the commit, never inside it.
      await tx.flushPostCommit((key, error) => {
        this.logger.warn(`post-commit action failed (${key}): ${error instanceof Error ? error.message : String(error)}`);
      });
      return result;
    } catch (error) {
      tx.discardPostCommit();
      try {
        if (!committed) await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken ? new Error("connection discarded after failed rollback") : undefined);
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  /**
   * Fail fast when RLS would be a lie (bypassing role) or a lockout (subject
   * role with RLS off) — same rule as the reference's lifespan check.
   */
  async assertRoleMatchesIsolation(): Promise<void> {
    const { rows } = await this.pool.query<{ rolsuper: boolean; rolbypassrls: boolean; owns_tables: boolean; role_name: string }>(
      `SELECT r.rolsuper,
              r.rolbypassrls,
              COALESCE((SELECT bool_and(t.tableowner = current_user) FROM pg_tables t WHERE t.schemaname = 'public'), true) AS owns_tables,
              current_user AS role_name
       FROM pg_roles r
       WHERE r.rolname = current_user`,
    );
    const row = rows[0];
    if (!row) return;
    const bypasses = row.rolsuper || row.rolbypassrls || row.owns_tables;
    if (this.settings.rlsEnabled && bypasses) {
      throw new RoleIsolationMismatchError(
        `SYNAPSE_TENANT_ISOLATION=app_and_rls but DB role '${row.role_name}' bypasses RLS (superuser, BYPASSRLS, or table owner). Connect the API as a subject role.`,
      );
    }
    if (!this.settings.rlsEnabled && !bypasses) {
      throw new RoleIsolationMismatchError(
        `SYNAPSE_TENANT_ISOLATION=app but DB role '${row.role_name}' is subject to RLS policies; every tenant query would return zero rows. Set app_and_rls or connect as the owner.`,
      );
    }
  }

  private async prime(tx: Tx): Promise<void> {
    if (!this.settings.rlsEnabled) return;
    const user = this.context.user();
    if (user && user.apiKeyId === null) await tx.bindUser(user.userId);
    const tenant = this.context.tenant();
    if (tenant?.isPlatform) await tx.bindPlatform();
    else if (tenant) await tx.bindTenant(tenant.organizationId);
  }
}
