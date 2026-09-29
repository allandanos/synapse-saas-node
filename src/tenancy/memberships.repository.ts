import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";
import type { OrganizationRow } from "./organizations.repository";

export interface MembershipRow {
  id: string;
  organization_id: string;
  user_id: string | null;
  invited_email: string | null;
  status: string;
  joined_at: Date | null;
  permission_keys: string[];
  created_at: Date;
  user_email: string | null;
  user_display_name: string | null;
  /** Sorted role keys. */
  role_keys: string[];
}

export interface MembershipRead {
  id: string;
  organization_id: string;
  user_id: string | null;
  invited_email: string | null;
  email: string | null;
  display_name: string | null;
  status: string;
  joined_at: Date | null;
  role_keys: string[];
  created_at: Date;
}

export function toMembershipRead(row: MembershipRow): MembershipRead {
  return {
    id: row.id,
    organization_id: row.organization_id,
    user_id: row.user_id,
    invited_email: row.invited_email,
    email: row.user_email,
    display_name: row.user_display_name,
    status: row.status,
    joined_at: row.joined_at,
    role_keys: row.role_keys,
    created_at: row.created_at,
  };
}

export interface MembershipWithOrganization {
  membership: MembershipRow;
  organization: OrganizationRow;
}

const MEMBERSHIP_SELECT = `
  SELECT m.id, m.organization_id, m.user_id, m.invited_email, m.status, m.joined_at, m.permission_keys, m.created_at,
         u.email AS user_email, u.display_name AS user_display_name,
         COALESCE((SELECT array_agg(r.key ORDER BY r.key)
                   FROM membership_roles mr JOIN roles r ON r.id = mr.role_id
                   WHERE mr.membership_id = m.id), '{}') AS role_keys
  FROM memberships m
  LEFT JOIN users u ON u.id = m.user_id`;

@Injectable()
export class MembershipsRepository {
  forOrganization(tx: Tx, organizationId: string, limit: number, offset: number): Promise<MembershipRow[]> {
    return tx.rows<MembershipRow>(`${MEMBERSHIP_SELECT} WHERE m.organization_id = $1 ORDER BY m.created_at, m.id LIMIT $2 OFFSET $3`, [
      organizationId,
      limit,
      offset,
    ]);
  }

  /** A user's active memberships with their organizations — `/auth/me`, `GET /orgs`. */
  async forUser(tx: Tx, userId: string): Promise<MembershipWithOrganization[]> {
    type Row = MembershipRow & {
      org_slug: string;
      org_name: string;
      org_status: string;
      org_owner_user_id: string | null;
      org_settings: Record<string, unknown>;
      org_created_at: Date;
      org_updated_at: Date;
      org_deleted_at: Date | null;
    };
    const rows = await tx.rows<Row>(
      `SELECT m.id, m.organization_id, m.user_id, m.invited_email, m.status, m.joined_at, m.permission_keys, m.created_at,
              NULL::text AS user_email, NULL::text AS user_display_name,
              COALESCE((SELECT array_agg(r.key ORDER BY r.key)
                        FROM membership_roles mr JOIN roles r ON r.id = mr.role_id
                        WHERE mr.membership_id = m.id), '{}') AS role_keys,
              o.slug AS org_slug, o.name AS org_name, o.status AS org_status, o.owner_user_id AS org_owner_user_id,
              o.settings AS org_settings, o.created_at AS org_created_at, o.updated_at AS org_updated_at, o.deleted_at AS org_deleted_at
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 AND m.status = 'active'
       ORDER BY m.created_at, m.id`,
      [userId],
    );
    return rows.map((row) => ({
      membership: row,
      organization: {
        id: row.organization_id,
        slug: row.org_slug,
        name: row.org_name,
        status: row.org_status,
        owner_user_id: row.org_owner_user_id,
        settings: row.org_settings,
        created_at: row.org_created_at,
        updated_at: row.org_updated_at,
        deleted_at: row.org_deleted_at,
      },
    }));
  }

  getActive(tx: Tx, organizationId: string, userId: string): Promise<MembershipRow | undefined> {
    return tx.one<MembershipRow>(`${MEMBERSHIP_SELECT} WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'active'`, [
      organizationId,
      userId,
    ]);
  }

  findById(tx: Tx, membershipId: string): Promise<MembershipRow | undefined> {
    return tx.one<MembershipRow>(`${MEMBERSHIP_SELECT} WHERE m.id = $1`, [membershipId]);
  }

  /** The pending invite for an address — the dev seed's auto-accept path (reference `find_pending_invite`). */
  findPendingInviteByEmail(tx: Tx, organizationId: string, email: string): Promise<MembershipRow | undefined> {
    return tx.one<MembershipRow>(`${MEMBERSHIP_SELECT} WHERE m.organization_id = $1 AND m.invited_email = $2 AND m.status = 'invited'`, [
      organizationId,
      email,
    ]);
  }

  findInvitedByTokenHash(tx: Tx, tokenHash: string): Promise<MembershipRow | undefined> {
    return tx.one<MembershipRow>(`${MEMBERSHIP_SELECT} WHERE m.invite_token_hash = $1 AND m.status = 'invited'`, [tokenHash]);
  }

  /** SECURITY DEFINER lookup (migration 0013): resolves the org before any tenant is bound. */
  async organizationIdForInviteToken(tx: Tx, tokenHash: string): Promise<string | null> {
    const row = await tx.one<{ organization_id: string | null }>(`SELECT synapse_org_for_invite_token($1) AS organization_id`, [tokenHash]);
    return row?.organization_id ?? null;
  }

  async countByStatus(tx: Tx, organizationId: string, status: "active" | "invited" | "suspended"): Promise<number> {
    const row = await tx.one<{ count: number }>(`SELECT count(*)::int AS count FROM memberships WHERE organization_id = $1 AND status = $2`, [
      organizationId,
      status,
    ]);
    return row?.count ?? 0;
  }

  async insert(
    tx: Tx,
    m: { organizationId: string; userId: string | null; invitedEmail: string | null; status: "active" | "invited"; inviteTokenHash: string | null },
  ): Promise<string> {
    const id = newUuid();
    await tx.query(
      `INSERT INTO memberships (id, organization_id, user_id, invited_email, status, joined_at, permission_keys, invite_token_hash)
       VALUES ($1, $2, $3, $4, $5::text, CASE WHEN $5::text = 'active' THEN now() ELSE NULL END, '{}', $6)`,
      [id, m.organizationId, m.userId, m.invitedEmail, m.status, m.inviteTokenHash],
    );
    return id;
  }

  async setStatus(tx: Tx, membershipId: string, status: string): Promise<void> {
    await tx.query(`UPDATE memberships SET status = $2, updated_at = now() WHERE id = $1`, [membershipId, status]);
  }

  /** Convert an invite into an active membership (single-use token cleared). */
  async accept(tx: Tx, membershipId: string, userId: string, email: string): Promise<void> {
    await tx.query(
      `UPDATE memberships
       SET user_id = $2, invited_email = $3, status = 'active', joined_at = now(), invite_token_hash = NULL, updated_at = now()
       WHERE id = $1`,
      [membershipId, userId, email],
    );
  }

  async delete(tx: Tx, membershipId: string): Promise<void> {
    await tx.query(`DELETE FROM memberships WHERE id = $1`, [membershipId]);
  }
}
