import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";

export interface UserRow {
  id: string;
  email: string;
  /** NULL ⇒ OIDC-only account (no local password). */
  password_hash: string | null;
  display_name: string;
  avatar_url: string | null;
  is_platform_admin: boolean;
  is_active: boolean;
  last_login_at: Date | null;
  identity_provider: string;
  provider_subject: string | null;
  created_at: Date;
}

export interface UserRead {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  is_platform_admin: boolean;
  is_active: boolean;
  last_login_at: Date | null;
}

export function toUserRead(row: UserRow): UserRead {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    is_platform_admin: row.is_platform_admin,
    is_active: row.is_active,
    last_login_at: row.last_login_at,
  };
}

const COLUMNS =
  "id, email, password_hash, display_name, avatar_url, is_platform_admin, is_active, last_login_at, identity_provider, provider_subject, created_at";

@Injectable()
export class UsersRepository {
  findByEmail(tx: Tx, email: string): Promise<UserRow | undefined> {
    return tx.one<UserRow>(`SELECT ${COLUMNS} FROM users WHERE email = $1`, [email]);
  }

  findById(tx: Tx, id: string): Promise<UserRow | undefined> {
    return tx.one<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  }

  async insert(
    tx: Tx,
    user: { email: string; passwordHash: string | null; displayName: string; isPlatformAdmin?: boolean; identityProvider?: string },
  ): Promise<UserRow> {
    const row = await tx.one<UserRow>(
      `INSERT INTO users (id, email, password_hash, display_name, is_platform_admin, is_active, identity_provider)
       VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING ${COLUMNS}`,
      [newUuid(), user.email, user.passwordHash, user.displayName, user.isPlatformAdmin ?? false, user.identityProvider ?? "local"],
    );
    return row as UserRow;
  }

  async touchLastLogin(tx: Tx, id: string): Promise<void> {
    await tx.query(`UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1`, [id]);
  }

  async setPasswordHash(tx: Tx, id: string, passwordHash: string): Promise<void> {
    await tx.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [id, passwordHash]);
  }

  async setPlatformAdmin(tx: Tx, id: string, isPlatformAdmin: boolean): Promise<void> {
    await tx.query(`UPDATE users SET is_platform_admin = $2, updated_at = now() WHERE id = $1`, [id, isPlatformAdmin]);
  }
}
