import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  organization_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by_token_id: string | null;
}

export interface PasswordResetTokenRow {
  id: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
}

/** Refresh-token sessions (rotated, hashed at rest) and single-use password-reset tokens. */
@Injectable()
export class TokensRepository {
  async insertRefresh(
    tx: Tx,
    token: { userId: string; tokenHash: string; organizationId: string | null; expiresAt: Date; userAgent: string | null; ip: string | null },
  ): Promise<string> {
    const id = newUuid();
    await tx.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, organization_id, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, token.userId, token.tokenHash, token.organizationId, token.expiresAt, token.userAgent?.slice(0, 500) ?? null, token.ip?.slice(0, 45) ?? null],
    );
    return id;
  }

  findRefreshByHash(tx: Tx, tokenHash: string): Promise<RefreshTokenRow | undefined> {
    return tx.one<RefreshTokenRow>(
      `SELECT id, user_id, token_hash, organization_id, expires_at, revoked_at, replaced_by_token_id FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
  }

  /** Mark rotated, linked to the successor. */
  async rotateRefresh(tx: Tx, id: string, successorId: string, at: Date): Promise<void> {
    await tx.query(`UPDATE refresh_tokens SET revoked_at = $2, replaced_by_token_id = $3 WHERE id = $1`, [id, at, successorId]);
  }

  async revokeRefresh(tx: Tx, id: string): Promise<void> {
    await tx.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
  }

  async revokeAllForUser(tx: Tx, userId: string): Promise<void> {
    await tx.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  }

  async insertReset(tx: Tx, token: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    await tx.query(`INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, max_uses) VALUES ($1, $2, $3, $4, 1)`, [
      newUuid(),
      token.userId,
      token.tokenHash,
      token.expiresAt,
    ]);
  }

  findUsableReset(tx: Tx, tokenHash: string): Promise<PasswordResetTokenRow | undefined> {
    return tx.one<PasswordResetTokenRow>(
      `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at >= now()`,
      [tokenHash],
    );
  }

  async markResetUsed(tx: Tx, id: string): Promise<void> {
    await tx.query(`UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`, [id]);
  }
}
