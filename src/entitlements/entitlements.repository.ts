import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";

export interface EntitlementRow {
  id: string;
  organization_id: string;
  feature_key: string;
  source: string;
  enabled: boolean;
  starts_at: Date;
  ends_at: Date | null;
  note: string | null;
  limit_value: number | null;
  created_by_user_id: string | null;
  revoked_at: Date | null;
}

const COLUMNS = "id, organization_id, feature_key, source, enabled, starts_at, ends_at, note, limit_value, created_by_user_id, revoked_at";

@Injectable()
export class EntitlementsRepository {
  /** Un-revoked grants of an organization (the resolver applies the time window). */
  activeForOrganization(tx: Tx, organizationId: string): Promise<EntitlementRow[]> {
    return tx.rows<EntitlementRow>(`SELECT ${COLUMNS} FROM entitlements WHERE organization_id = $1 AND revoked_at IS NULL ORDER BY created_at, id`, [organizationId]);
  }

  findById(tx: Tx, id: string): Promise<EntitlementRow | undefined> {
    return tx.one<EntitlementRow>(`SELECT ${COLUMNS} FROM entitlements WHERE id = $1`, [id]);
  }

  async insert(
    tx: Tx,
    e: {
      organizationId: string;
      featureKey: string;
      source: string;
      enabled: boolean;
      startsAt: Date;
      endsAt: Date | null;
      note: string | null;
      limitValue: number | null;
      createdByUserId: string | null;
    },
  ): Promise<EntitlementRow> {
    const row = await tx.one<EntitlementRow>(
      `INSERT INTO entitlements (id, organization_id, feature_key, source, enabled, starts_at, ends_at, note, limit_value, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${COLUMNS}`,
      [newUuid(), e.organizationId, e.featureKey, e.source, e.enabled, e.startsAt, e.endsAt, e.note, e.limitValue, e.createdByUserId],
    );
    return row as EntitlementRow;
  }

  async revoke(tx: Tx, id: string, at: Date): Promise<void> {
    await tx.query(`UPDATE entitlements SET revoked_at = $2, updated_at = now() WHERE id = $1`, [id, at]);
  }
}
