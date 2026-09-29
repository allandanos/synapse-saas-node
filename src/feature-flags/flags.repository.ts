import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";

export interface FeatureFlagRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  rollout_percentage: number | null;
  archived_at: Date | null;
  created_at: Date;
}

export interface FeatureFlagOverrideRow {
  id: string;
  flag_key: string;
  organization_id: string | null;
  user_id: string | null;
  enabled: boolean;
  note: string | null;
  created_at: Date;
}

export interface FlagRead {
  id: string;
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  rollout_percentage: number | null;
  created_at: Date;
}

export function toFlagRead(row: FeatureFlagRow): FlagRead {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    rollout_percentage: row.rollout_percentage,
    created_at: row.created_at,
  };
}

const FLAG_COLUMNS = "id, key, name, description, enabled, rollout_percentage, archived_at, created_at";
const OVERRIDE_COLUMNS = "id, flag_key, organization_id, user_id, enabled, note, created_at";

@Injectable()
export class FlagsRepository {
  /** Live definition of a flag; an archived flag reads as unknown. */
  findByKey(tx: Tx, key: string): Promise<FeatureFlagRow | undefined> {
    return tx.one<FeatureFlagRow>(`SELECT ${FLAG_COLUMNS} FROM feature_flags WHERE key = $1 AND archived_at IS NULL`, [key]);
  }

  listFlags(tx: Tx): Promise<FeatureFlagRow[]> {
    return tx.rows<FeatureFlagRow>(`SELECT ${FLAG_COLUMNS} FROM feature_flags WHERE archived_at IS NULL ORDER BY key`, []);
  }

  async insertFlag(
    tx: Tx,
    flag: { key: string; name: string; description: string | null; enabled: boolean; rolloutPercentage: number | null },
  ): Promise<FeatureFlagRow> {
    const row = await tx.one<FeatureFlagRow>(
      `INSERT INTO feature_flags (id, key, name, description, enabled, rollout_percentage)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${FLAG_COLUMNS}`,
      [newUuid(), flag.key, flag.name, flag.description, flag.enabled, flag.rolloutPercentage],
    );
    return row as FeatureFlagRow;
  }

  async updateFlag(tx: Tx, key: string, patch: { enabled?: boolean; rolloutPercentage?: number }): Promise<FeatureFlagRow> {
    const row = await tx.one<FeatureFlagRow>(
      `UPDATE feature_flags
          SET enabled = COALESCE($2, enabled),
              rollout_percentage = COALESCE($3, rollout_percentage),
              updated_at = now()
        WHERE key = $1 AND archived_at IS NULL RETURNING ${FLAG_COLUMNS}`,
      [key, patch.enabled ?? null, patch.rolloutPercentage ?? null],
    );
    return row as FeatureFlagRow;
  }

  /**
   * The override that applies to a scope. A user override is looked up by user
   * alone (it outranks every org rule); an org override must not carry a user.
   */
  findOverride(tx: Tx, flagKey: string, scope: { organizationId?: string | null; userId?: string | null }): Promise<FeatureFlagOverrideRow | undefined> {
    if (scope.userId) {
      return tx.one<FeatureFlagOverrideRow>(`SELECT ${OVERRIDE_COLUMNS} FROM feature_flag_overrides WHERE flag_key = $1 AND user_id = $2`, [flagKey, scope.userId]);
    }
    if (scope.organizationId) {
      return tx.one<FeatureFlagOverrideRow>(
        `SELECT ${OVERRIDE_COLUMNS} FROM feature_flag_overrides WHERE flag_key = $1 AND organization_id = $2 AND user_id IS NULL`,
        [flagKey, scope.organizationId],
      );
    }
    return Promise.resolve(undefined);
  }

  listOverrides(tx: Tx, flagKey: string): Promise<FeatureFlagOverrideRow[]> {
    return tx.rows<FeatureFlagOverrideRow>(`SELECT ${OVERRIDE_COLUMNS} FROM feature_flag_overrides WHERE flag_key = $1 ORDER BY created_at DESC`, [flagKey]);
  }

  async insertOverride(
    tx: Tx,
    override: { flagKey: string; organizationId: string | null; userId: string | null; enabled: boolean; note: string | null },
  ): Promise<FeatureFlagOverrideRow> {
    const row = await tx.one<FeatureFlagOverrideRow>(
      `INSERT INTO feature_flag_overrides (id, flag_key, organization_id, user_id, enabled, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${OVERRIDE_COLUMNS}`,
      [newUuid(), override.flagKey, override.organizationId, override.userId, override.enabled, override.note],
    );
    return row as FeatureFlagOverrideRow;
  }

  async updateOverride(tx: Tx, id: string, patch: { enabled: boolean; note: string | null }): Promise<FeatureFlagOverrideRow> {
    const row = await tx.one<FeatureFlagOverrideRow>(
      `UPDATE feature_flag_overrides SET enabled = $2, note = $3, updated_at = now() WHERE id = $1 RETURNING ${OVERRIDE_COLUMNS}`,
      [id, patch.enabled, patch.note],
    );
    return row as FeatureFlagOverrideRow;
  }

  findOverrideById(tx: Tx, id: string): Promise<FeatureFlagOverrideRow | undefined> {
    return tx.one<FeatureFlagOverrideRow>(`SELECT ${OVERRIDE_COLUMNS} FROM feature_flag_overrides WHERE id = $1`, [id]);
  }

  async deleteOverride(tx: Tx, id: string): Promise<void> {
    await tx.query(`DELETE FROM feature_flag_overrides WHERE id = $1`, [id]);
  }
}
