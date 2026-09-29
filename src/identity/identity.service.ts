import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { AuditWriter } from "../core/audit";
import { SETTINGS, type Settings } from "../core/config";
import { Database, type Tx } from "../core/db/database";
import {
  AuthenticationError,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  TenantNotResolvedError,
  TokenReuseError,
  UserNotFoundError,
} from "../core/errors";
import { events } from "../core/events";
import { OutboxWriter } from "../core/outbox";
import { DUMMY_PASSWORD_HASH, SecurityService } from "../core/security";
import { MembershipsRepository } from "../tenancy/memberships.repository";
import { TokensRepository } from "./tokens.repository";
import { type UserRead, type UserRow, UsersRepository, toUserRead } from "./users.repository";

const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
}

export interface AuthResponse {
  user: UserRead;
  tokens: TokenPair;
}

export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  role_keys: string[];
}

export interface UserWithOrgs extends UserRead {
  orgs: OrgSummary[];
}

export interface RequestMeta {
  userAgent?: string | null;
  ip?: string | null;
}

/**
 * Registration, login, refresh-token rotation with reuse detection, logout,
 * password reset. Rotation model: every refresh mints a new token and links
 * old→new; presenting an already-rotated token outside a small grace window
 * (concurrent tabs) is a theft signal — the whole chain is revoked.
 */
@Injectable()
export class IdentityService {
  constructor(
    private readonly db: Database,
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly security: SecurityService,
    private readonly users: UsersRepository,
    private readonly tokens: TokensRepository,
    private readonly members: MembershipsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  // ── Registration / login ────────────────────────────────────────────────────

  async register(input: { email: string; password: string; displayName: string }): Promise<AuthResponse> {
    const passwordHash = await this.security.hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      if (await this.users.findByEmail(tx, input.email)) {
        throw new EmailAlreadyRegisteredError("An account with this email already exists");
      }
      const user = await this.users.insert(tx, { email: input.email, passwordHash, displayName: input.displayName });
      await this.audit.log(tx, { eventType: events.USER_REGISTERED, actorUserId: user.id, diff: { email: input.email } });
      const { pair } = await this.issueTokens(tx, user, {});
      return { user: toUserRead(user), tokens: pair };
    });
  }

  async login(input: { email: string; password: string }, meta: RequestMeta): Promise<AuthResponse> {
    const user = await this.db.transaction((tx) => this.users.findByEmail(tx, input.email));
    if (user && user.identity_provider !== "local" && user.password_hash === null) {
      // SSO-only account: the password form cannot sign it in — point at the flow that can
      await this.security.verifyPassword(input.password, DUMMY_PASSWORD_HASH);
      throw new AuthenticationError("This account signs in with single sign-on", {
        sso_url: "/v1/auth/oidc/start",
        identity_provider: user.identity_provider,
      });
    }
    if (!user || user.password_hash === null || !user.is_active) {
      if (!user) await this.security.verifyPassword(input.password, DUMMY_PASSWORD_HASH); // timing equalization
      throw new InvalidCredentialsError("Invalid email or password");
    }
    if (!(await this.security.verifyPassword(input.password, user.password_hash))) {
      await this.db.transaction((tx) =>
        this.audit.log(tx, { eventType: events.USER_LOGIN_FAILED, actorUserId: user.id, diff: { email: input.email } }),
      );
      throw new InvalidCredentialsError("Invalid email or password");
    }
    return this.db.transaction(async (tx) => {
      await this.users.touchLastLogin(tx, user.id);
      await this.audit.log(tx, { eventType: events.USER_LOGIN_SUCCEEDED, actorUserId: user.id });
      const { pair } = await this.issueTokens(tx, user, meta);
      return { user: toUserRead({ ...user, last_login_at: new Date() }), tokens: pair };
    });
  }

  // ── SSO (OIDC) ──────────────────────────────────────────────────────────────

  /**
   * Resolve an OIDC identity to a local user, in this order:
   *
   * 1. by `(identity_provider, provider_subject)` — the stable link;
   * 2. else by email, ONLY when the provider asserts `email_verified` — an
   *    unverified email must never take over an existing local account;
   * 3. else create an SSO-only user (no local password).
   *
   * An existing account whose email the IdP has NOT verified is refused
   * outright rather than merged.
   */
  linkOrCreateOidcUser(tx: Tx, claims: Record<string, unknown>, provider = "keycloak"): Promise<UserRow> {
    const subject = String(claims.sub ?? "");
    if (!subject) throw new AuthenticationError("OIDC claims carry no subject");
    const email = String(claims.email ?? "")
      .trim()
      .toLowerCase();
    const displayName = String(claims.name ?? claims.preferred_username ?? email ?? subject);
    return this.resolveOidcUser(tx, { provider, subject, email, displayName, emailVerified: claims.email_verified === true });
  }

  private async resolveOidcUser(
    tx: Tx,
    input: { provider: string; subject: string; email: string; displayName: string; emailVerified: boolean },
  ): Promise<UserRow> {
    const bySubject = await this.users.findByProviderSubject(tx, input.provider, input.subject);
    if (bySubject) {
      if (!bySubject.is_active) throw new AuthenticationError("User is inactive");
      await this.users.touchLastLogin(tx, bySubject.id);
      await this.audit.log(tx, { eventType: events.USER_LOGIN_SUCCEEDED, actorUserId: bySubject.id, diff: { via: input.provider } });
      return { ...bySubject, last_login_at: new Date() };
    }

    const existing = input.email ? await this.users.findByEmail(tx, input.email) : undefined;
    if (existing && input.emailVerified) {
      if (!existing.is_active) throw new AuthenticationError("User is inactive");
      await this.users.linkProvider(tx, existing.id, input.provider, input.subject);
      await this.users.touchLastLogin(tx, existing.id);
      await this.audit.log(tx, {
        eventType: events.USER_LOGIN_SUCCEEDED,
        actorUserId: existing.id,
        diff: { via: input.provider, linked: "verified_email" },
      });
      return { ...existing, identity_provider: input.provider, provider_subject: input.subject, last_login_at: new Date() };
    }

    if (!input.email) throw new AuthenticationError("OIDC claims carry no email; cannot create a user");
    if (existing) {
      // Same email, unverified at the IdP: refuse rather than merge accounts
      throw new AuthenticationError("An account with this email exists; verify the email at your identity provider first", { reason: "email_unverified" });
    }
    const user = await this.users.insert(tx, {
      email: input.email,
      passwordHash: null, // SSO-only: the password form cannot sign it in
      displayName: input.displayName,
      identityProvider: input.provider,
      providerSubject: input.subject,
    });
    await this.audit.log(tx, { eventType: events.USER_REGISTERED, actorUserId: user.id, diff: { via: input.provider } });
    return user;
  }

  // ── Tokens ──────────────────────────────────────────────────────────────────

  async issueTokens(
    tx: Tx,
    user: UserRow,
    meta: RequestMeta & { organizationId?: string | null },
  ): Promise<{ pair: TokenPair; refreshTokenId: string }> {
    const refreshToken = this.security.generateRefreshToken();
    const refreshTokenId = await this.tokens.insertRefresh(tx, {
      userId: user.id,
      tokenHash: this.security.hashToken(refreshToken),
      organizationId: meta.organizationId ?? null,
      expiresAt: new Date(Date.now() + this.settings.refreshTokenTtlSeconds * 1000),
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    });
    const accessToken = this.security.createAccessToken({
      userId: user.id,
      email: user.email,
      organizationId: meta.organizationId ?? null,
      isPlatformAdmin: user.is_platform_admin,
    });
    return {
      pair: { access_token: accessToken, refresh_token: refreshToken, token_type: "bearer", expires_in: this.settings.accessTokenTtlSeconds },
      refreshTokenId,
    };
  }

  /** Rotate a refresh token. Reuse of a rotated token revokes the chain (durably, before the 401). */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<TokenPair> {
    const tokenHash = this.security.hashToken(refreshToken);
    const graceMs = this.settings.SYNAPSE_REFRESH_REUSE_GRACE_SECONDS * 1000;
    const outcome = await this.db.transaction(async (tx): Promise<{ reuse: true } | { reuse: false; pair: TokenPair }> => {
      const row = await this.tokens.findRefreshByHash(tx, tokenHash);
      if (!row) throw new AuthenticationError("Invalid refresh token");
      const now = new Date();
      if (row.expires_at < now) throw new AuthenticationError("Refresh token expired");
      if (row.revoked_at !== null) {
        // Already rotated? Within grace = benign concurrent refresh; else theft.
        const withinGrace = row.replaced_by_token_id !== null && now.getTime() - row.revoked_at.getTime() <= graceMs;
        if (!withinGrace) {
          await this.tokens.revokeAllForUser(tx, row.user_id);
          await this.audit.log(tx, { eventType: events.USER_TOKEN_REUSE_DETECTED, actorUserId: row.user_id });
          return { reuse: true };
        }
        throw new AuthenticationError("Refresh token already used");
      }
      const user = await this.users.findById(tx, row.user_id);
      if (!user || !user.is_active) throw new AuthenticationError("Invalid refresh token");
      const { pair, refreshTokenId } = await this.issueTokens(tx, user, { ...meta, organizationId: row.organization_id });
      await this.tokens.rotateRefresh(tx, row.id, refreshTokenId, now);
      await this.audit.log(tx, { eventType: events.USER_TOKEN_REFRESHED, actorUserId: user.id });
      return { reuse: false, pair };
    });
    if (outcome.reuse) throw new TokenReuseError("Refresh token reuse detected; session revoked");
    return outcome.pair;
  }

  logout(refreshToken: string): Promise<void> {
    const tokenHash = this.security.hashToken(refreshToken);
    return this.db.transaction(async (tx) => {
      const row = await this.tokens.findRefreshByHash(tx, tokenHash);
      if (row && row.revoked_at === null) {
        await this.tokens.revokeRefresh(tx, row.id);
        await this.audit.log(tx, { eventType: events.USER_LOGGED_OUT, actorUserId: row.user_id });
      }
    });
  }

  /** Mint a pair scoped to one of the user's active orgs (the `org` claim). */
  switchOrganization(userId: string, organizationId: string, meta: RequestMeta): Promise<TokenPair> {
    return this.db.transaction(async (tx) => {
      const membership = await this.members.getActive(tx, organizationId, userId);
      if (!membership) throw new TenantNotResolvedError("Organization not found");
      const user = await this.users.findById(tx, userId);
      if (!user) throw new UserNotFoundError("User not found");
      return (await this.issueTokens(tx, user, { ...meta, organizationId })).pair;
    });
  }

  me(userId: string): Promise<UserWithOrgs> {
    return this.db.transaction(async (tx) => {
      const user = await this.users.findById(tx, userId);
      if (!user) throw new UserNotFoundError("User not found");
      const orgs = (await this.members.forUser(tx, userId)).map(({ membership, organization }) => ({
        id: organization.id,
        slug: organization.slug,
        name: organization.name,
        role_keys: membership.role_keys,
      }));
      return { ...toUserRead(user), orgs };
    });
  }

  // ── Password reset ──────────────────────────────────────────────────────────

  /** Same response whether or not the email exists; the link rides the internal outbox only. */
  requestPasswordReset(email: string): Promise<void> {
    return this.db.transaction(async (tx) => {
      const user = await this.users.findByEmail(tx, email);
      if (!user) return; // never reveal whether the email exists
      const token = randomBytes(RESET_TOKEN_BYTES).toString("base64url");
      await this.tokens.insertReset(tx, {
        userId: user.id,
        tokenHash: this.security.hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      });
      await this.audit.log(tx, { eventType: events.USER_PASSWORD_RESET_REQUESTED, actorUserId: user.id });
      await this.outbox.append(tx, {
        eventType: events.USER_PASSWORD_RESET_LINK,
        aggregateType: "user",
        aggregateId: user.id,
        organizationId: null,
        payload: { email, token },
      });
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<AuthResponse> {
    const passwordHash = await this.security.hashPassword(newPassword);
    return this.db.transaction(async (tx) => {
      const row = await this.tokens.findUsableReset(tx, this.security.hashToken(token));
      if (!row) throw new AuthenticationError("Invalid or expired reset token");
      const user = await this.users.findById(tx, row.user_id);
      if (!user) throw new UserNotFoundError("User not found");
      await this.users.setPasswordHash(tx, user.id, passwordHash);
      await this.tokens.markResetUsed(tx, row.id);
      await this.tokens.revokeAllForUser(tx, user.id); // all sessions die on password change
      await this.audit.log(tx, { eventType: events.USER_PASSWORD_RESET_COMPLETED, actorUserId: user.id });
      const { pair } = await this.issueTokens(tx, user, {});
      return { user: toUserRead(user), tokens: pair };
    });
  }
}
