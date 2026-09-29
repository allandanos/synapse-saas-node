import { Inject, Injectable, Logger } from "@nestjs/common";
import { SETTINGS, type Settings } from "../../core/config";
import { Database, type Tx } from "../../core/db/database";
import { events } from "../../core/events";
import { uuidV7 } from "../../core/ids";
import { OutboxWriter } from "../../core/outbox";
import { SYSTEM_ROLES } from "../permissions";
import { FgaClient, type FgaTuple, tupleId } from "./client";
import { relationFor, ROLE_ORDER } from "./model";

export function userObject(userId: string): string {
  return `user:${userId}`;
}

export function orgObject(organizationId: string): string {
  return `organization:${organizationId}`;
}

/**
 * What OpenFGA must hold for one active member (`authorization/sync.py`).
 *
 * A system role becomes a role tuple — the model derives its permissions, so
 * writing them again would be redundant and would survive a catalog change.
 * A permission that only a CUSTOM role grants has no relation of its own, so
 * it is written as a direct `can_*` tuple.
 */
export function desiredTuples(input: {
  userId: string;
  organizationId: string;
  roleKeys: readonly string[];
  permissionKeys: readonly string[];
}): FgaTuple[] {
  const org = orgObject(input.organizationId);
  const user = userObject(input.userId);
  const systemRoles = input.roleKeys.filter((key): key is (typeof ROLE_ORDER)[number] => (ROLE_ORDER as readonly string[]).includes(key));
  const tuples = new Map<string, FgaTuple>();
  const add = (tuple: FgaTuple): void => {
    tuples.set(tupleId(tuple), tuple);
  };
  for (const role of systemRoles) add({ user, relation: role, object: org });
  const covered = new Set(systemRoles.flatMap((role) => SYSTEM_ROLES[role]?.permissions ?? []));
  for (const permission of input.permissionKeys) {
    if (!covered.has(permission)) add({ user, relation: relationFor(permission), object: org });
  }
  return [...tuples.values()];
}

/**
 * The sync reads memberships directly rather than through
 * `MembershipsRepository`: the tenancy module already depends on the
 * authorization module, and a repository import here would close the cycle
 * for two denormalised columns.
 */
function memberPairs(tx: Tx, organizationId?: string): Promise<{ organization_id: string; user_id: string }[]> {
  return organizationId === undefined
    ? tx.rows(`SELECT organization_id, user_id FROM memberships WHERE user_id IS NOT NULL ORDER BY organization_id, user_id`)
    : tx.rows(`SELECT organization_id, user_id FROM memberships WHERE user_id IS NOT NULL AND organization_id = $1 ORDER BY user_id`, [
        organizationId,
      ]);
}

function memberState(tx: Tx, organizationId: string, userId: string): Promise<{ status: string; permission_keys: string[]; role_keys: string[] } | undefined> {
  return tx.one(
    `SELECT m.status, m.permission_keys,
            COALESCE((SELECT array_agg(r.key ORDER BY r.key)
                      FROM membership_roles mr JOIN roles r ON r.id = mr.role_id
                      WHERE mr.membership_id = m.id), '{}') AS role_keys
     FROM memberships m WHERE m.organization_id = $1 AND m.user_id = $2`,
    [organizationId, userId],
  );
}

/**
 * Tuple sync: RBAC (the source of truth) → OpenFGA relationship tuples.
 *
 * Request side: `queue()` appends an internal outbox event inside the mutating
 * transaction. Worker side: `apply()` recomputes the member's desired tuples
 * from the database and writes/deletes the difference. The outbox carries the
 * retries and the dead-lettering, so no request ever waits on OpenFGA and a
 * transient outage is replayed rather than lost.
 */
@Injectable()
export class FgaSyncService {
  private readonly logger = new Logger(FgaSyncService.name);

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly db: Database,
    private readonly outbox: OutboxWriter,
  ) {}

  client(): FgaClient {
    return new FgaClient(this.settings);
  }

  get enabled(): boolean {
    return this.settings.SYNAPSE_AUTHZ_BACKEND === "openfga";
  }

  /** Record that this member's tuples must be recomputed (a no-op without OpenFGA). */
  async queue(tx: Tx, organizationId: string, userId: string | null): Promise<void> {
    if (userId === null || !this.enabled) return;
    await this.outbox.append(tx, {
      eventType: events.AUTHZ_TUPLES_CHANGED,
      aggregateType: "membership",
      aggregateId: uuidV7(),
      organizationId,
      payload: { organization_id: organizationId, user_id: userId },
    });
  }

  /** Outbox consumer entry point (internal audience); a no-op on the rbac backend. */
  async handleEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
    if (eventType !== events.AUTHZ_TUPLES_CHANGED || !this.enabled) return;
    await this.apply(String(payload.organization_id), payload.user_id === null ? null : String(payload.user_id));
  }

  /**
   * Converge OpenFGA to the member's current RBAC state. A null `userId`
   * means the whole organization (a custom-role edit touches every holder).
   */
  async apply(organizationId: string, userId: string | null, client?: FgaClient): Promise<{ writes: number; deletes: number }> {
    const fga = client ?? this.client();
    if (!fga.configured) {
      this.logger.warn(`fga sync skipped (unconfigured) org=${organizationId} user=${userId ?? "*"}`);
      return { writes: 0, deletes: 0 };
    }
    if (userId === null) {
      const pairs = await this.db.transaction(async (tx) => {
        await tx.bindPlatform();
        return memberPairs(tx, organizationId);
      });
      let writes = 0;
      let deletes = 0;
      for (const pair of pairs) {
        const result = await this.apply(pair.organization_id, pair.user_id, fga);
        writes += result.writes;
        deletes += result.deletes;
      }
      return { writes, deletes };
    }

    const desired = await this.db.transaction(async (tx) => {
      await tx.bindPlatform();
      const membership = await memberState(tx, organizationId, userId);
      if (!membership || membership.status !== "active") return [] as FgaTuple[];
      return desiredTuples({ userId, organizationId, roleKeys: membership.role_keys, permissionKeys: membership.permission_keys });
    });

    const user = userObject(userId);
    const current = (await fga.readTuples(orgObject(organizationId))).filter((tuple) => tuple.user === user);
    const desiredIds = new Set(desired.map(tupleId));
    const currentIds = new Set(current.map(tupleId));
    const byRelation = (a: FgaTuple, b: FgaTuple): number => a.relation.localeCompare(b.relation);
    const writes = desired.filter((tuple) => !currentIds.has(tupleId(tuple))).sort(byRelation);
    const deletes = current.filter((tuple) => !desiredIds.has(tupleId(tuple))).sort(byRelation);
    await fga.write(writes, deletes);
    this.logger.log(`fga tuples synced org=${organizationId} user=${userId} writes=${String(writes.length)} deletes=${String(deletes.length)}`);
    return { writes: writes.length, deletes: deletes.length };
  }

  /** `authz fga sync --all | --org <id>`: backfill or repair every membership. */
  async syncAll(organizationId?: string): Promise<number> {
    const fga = this.client();
    const pairs = await this.db.transaction(async (tx) => {
      await tx.bindPlatform();
      return memberPairs(tx, organizationId);
    });
    for (const pair of pairs) await this.apply(pair.organization_id, pair.user_id, fga);
    return pairs.length;
  }
}
