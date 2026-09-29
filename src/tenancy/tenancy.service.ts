import { Inject, Injectable, Logger } from "@nestjs/common";
import { RolesRepository } from "../authorization/roles.repository";
import { AuthorizationService } from "../authorization/authorization.service";
import { FgaSyncService } from "../authorization/fga/sync";
import { SYSTEM_ROLE_MEMBER, SYSTEM_ROLE_OWNER } from "../authorization/permissions";
import { AuditWriter } from "../core/audit";
import { SETTINGS, type Settings } from "../core/config";
import { Database, type Tx } from "../core/db/database";
import {
  InviteNotFoundError,
  MembershipLimitReachedError,
  NotAMemberError,
  OrganizationNotFoundError,
  RoleNotFoundError,
  SlugUnavailableError,
} from "../core/errors";
import { events } from "../core/events";
import { isValidSlug, slugify, uniqueSlug } from "../core/ids";
import { OutboxWriter } from "../core/outbox";
import { buildPage, type Page, type PageQuery } from "../core/pagination";
import { generateRefreshToken, sha256Hex } from "../core/security";
import { EntitlementsService, UPGRADE_URL } from "../entitlements/entitlements.service";
import { PlansRepository } from "../subscriptions/plans.repository";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { UsageService } from "../usage/usage.service";
import { type MembershipRead, MembershipsRepository, type MembershipRow, toMembershipRead } from "./memberships.repository";
import { type OrganizationRead, OrganizationsRepository, toOrganizationRead } from "./organizations.repository";

/**
 * Organization lifecycle + membership management. Every mutation writes audit
 * + outbox in the same transaction. Creating an org bootstraps the owner
 * membership with the `owner` system role and a default-plan subscription so
 * a new tenant is immediately functional; `users` is a gauge (active members
 * + pending invites) re-set after every membership change and enforced on
 * invite (402 `usage_limit_exceeded`, metric `users`).
 */
@Injectable()
export class TenancyService {
  private readonly logger = new Logger(TenancyService.name);

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly db: Database,
    private readonly orgs: OrganizationsRepository,
    private readonly members: MembershipsRepository,
    private readonly roles: RolesRepository,
    private readonly authz: AuthorizationService,
    private readonly fga: FgaSyncService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly plans: PlansRepository,
    private readonly subscriptions: SubscriptionsService,
    private readonly entitlements: EntitlementsService,
    private readonly usage: UsageService,
  ) {}

  // ── Organizations ───────────────────────────────────────────────────────────

  async createOrganization(input: { name: string; slug?: string | null; ownerUserId: string }): Promise<OrganizationRead> {
    const desired = input.slug || slugify(input.name);
    if (desired && !isValidSlug(desired)) {
      throw new SlugUnavailableError(`'${desired}' is reserved or invalid`, { slug: desired });
    }
    return this.db.transaction(async (tx) => {
      const finalSlug = desired && !(await this.orgs.slugExists(tx, desired)) ? desired : uniqueSlug(input.name);
      const org = await this.orgs.insert(tx, { slug: finalSlug, name: input.name, ownerUserId: input.ownerUserId });
      // This request has no tenant yet (POST /v1/orgs is user-scoped). Bind the
      // new org so the membership/audit/outbox writes below pass RLS.
      await tx.bindTenant(org.id);

      const membershipId = await this.members.insert(tx, {
        organizationId: org.id,
        userId: input.ownerUserId,
        invitedEmail: null,
        status: "active",
        inviteTokenHash: null,
      });
      await this.syncSeatGauge(tx, org.id);
      await this.attachRole(tx, membershipId, org.id, SYSTEM_ROLE_OWNER);
      // The owner must be able to act on the org they just created. The
      // reference never syncs tuples here (`tenancy/service.py::create_organization`),
      // which leaves an openfga-backed deployment denying its own owner until
      // `authz fga sync` runs — see docs/plans/milestone-7.md.
      await this.authz.invalidateUserPerms(tx, input.ownerUserId, org.id);

      await this.audit.log(tx, {
        eventType: events.ORG_CREATED,
        organizationId: org.id,
        targetType: "organization",
        targetId: org.id,
        diff: { name: input.name, slug: finalSlug },
      });
      await this.outbox.append(tx, {
        eventType: events.ORG_CREATED,
        aggregateType: "organization",
        aggregateId: org.id,
        organizationId: org.id,
        payload: { name: input.name, slug: finalSlug, owner_user_id: input.ownerUserId },
      });
      // Default-plan subscription so entitlements resolve immediately
      await this.bootstrapSubscription(tx, org.id);
      this.logger.log(`org created ${org.id} (${finalSlug})`);
      return toOrganizationRead(org);
    });
  }

  getOrganization(organizationId: string): Promise<OrganizationRead> {
    return this.db.transaction(async (tx) => toOrganizationRead(await this.mustFindOrganization(tx, organizationId)));
  }

  updateOrganization(organizationId: string, patch: { name?: string | null; settings?: Record<string, unknown> | null }): Promise<OrganizationRead> {
    return this.db.transaction(async (tx) => {
      const org = await this.mustFindOrganization(tx, organizationId);
      const diff: Record<string, unknown> = {};
      const update: { name?: string; settings?: Record<string, unknown> } = {};
      if (patch.name != null && patch.name !== org.name) {
        diff.name = { from: org.name, to: patch.name };
        update.name = patch.name;
      }
      if (patch.settings != null) {
        const merged = { ...org.settings, ...patch.settings };
        diff.settings = { from: org.settings, to: merged };
        update.settings = merged;
      }
      const updated = Object.keys(update).length > 0 ? await this.orgs.update(tx, organizationId, update) : org;
      if (Object.keys(diff).length > 0) await this.audit.log(tx, { eventType: events.ORG_UPDATED, organizationId, diff });
      return toOrganizationRead(updated);
    });
  }

  suspendOrganization(organizationId: string): Promise<void> {
    return this.setOrganizationStatus(organizationId, "suspended", events.ORG_SUSPENDED);
  }

  unsuspendOrganization(organizationId: string): Promise<void> {
    return this.setOrganizationStatus(organizationId, "active", events.ORG_UNSUSPENDED);
  }

  private setOrganizationStatus(organizationId: string, status: "active" | "suspended", eventType: string): Promise<void> {
    return this.db.transaction(async (tx) => {
      await this.mustFindOrganization(tx, organizationId);
      await this.orgs.setStatus(tx, organizationId, status);
      await this.audit.log(tx, { eventType, organizationId });
    });
  }

  // ── Memberships ─────────────────────────────────────────────────────────────

  listMyOrganizations(userId: string): Promise<Page<OrganizationRead>> {
    return this.db.transaction(async (tx) => {
      const orgs = (await this.members.forUser(tx, userId)).map((m) => toOrganizationRead(m.organization));
      return buildPage(orgs, { total: orgs.length, limit: 100, offset: 0 });
    });
  }

  listMembers(organizationId: string, page: PageQuery): Promise<Page<MembershipRead>> {
    return this.db.transaction(async (tx) => {
      const rows = await this.members.forOrganization(tx, organizationId, page.limit, page.offset);
      const total =
        (await this.members.countByStatus(tx, organizationId, "active")) + (await this.members.countByStatus(tx, organizationId, "invited"));
      return buildPage(rows.map(toMembershipRead), { total, limit: page.limit, offset: page.offset });
    });
  }

  /**
   * Invite by email: the token rides the internal outbox event only, never the
   * response. The `users` seat limit is enforced inside the same transaction as the insert.
   */
  inviteMember(input: {
    organizationId: string;
    email: string;
    roleKeys?: string[];
    organizationName: string;
    /** The seed populates a demo org past the free plan's seats; the reference
     * bypasses the same way (`invite_member(seat_limit=None)`). Always true over HTTP. */
    enforceSeatLimit?: boolean;
  }): Promise<MembershipRead> {
    const roleKeys = input.roleKeys && input.roleKeys.length > 0 ? input.roleKeys : [SYSTEM_ROLE_MEMBER];
    const enforceSeatLimit = input.enforceSeatLimit ?? true;
    return this.db.transaction(async (tx) => {
      const seatLimit = enforceSeatLimit ? (await this.entitlements.effectiveForOrg(tx, input.organizationId)).limitValue("users") : null;
      const active = await this.members.countByStatus(tx, input.organizationId, "active");
      const pending = await this.members.countByStatus(tx, input.organizationId, "invited");
      if (seatLimit !== null && active + pending + 1 > seatLimit) {
        throw new MembershipLimitReachedError("Seat limit reached for the current plan", {
          metric: "users",
          limit: seatLimit,
          used: active + pending,
          upgrade_url: UPGRADE_URL,
        });
      }
      const token = generateRefreshToken();
      const membershipId = await this.members.insert(tx, {
        organizationId: input.organizationId,
        userId: null,
        invitedEmail: input.email,
        status: "invited",
        inviteTokenHash: sha256Hex(token),
      });
      for (const key of roleKeys) await this.attachRole(tx, membershipId, input.organizationId, key);

      await this.audit.log(tx, {
        eventType: events.MEMBER_INVITED,
        organizationId: input.organizationId,
        targetType: "membership",
        targetId: membershipId,
        diff: { email: input.email, roles: roleKeys },
      });
      // Public event (tenant webhooks): no credential material, ever.
      await this.outbox.append(tx, {
        eventType: events.MEMBER_INVITED,
        aggregateType: "membership",
        aggregateId: membershipId,
        organizationId: input.organizationId,
        payload: { email: input.email, org_name: input.organizationName, membership_id: membershipId },
      });
      // Internal event (email only): the row keeps the hash; the token never fans out.
      await this.outbox.append(tx, {
        eventType: events.MEMBER_INVITE_EMAIL,
        aggregateType: "membership",
        aggregateId: membershipId,
        organizationId: input.organizationId,
        payload: { email: input.email, invite_token: token, org_name: input.organizationName },
      });
      await this.syncSeatGauge(tx, input.organizationId);
      return toMembershipRead(await this.mustFindMembership(tx, membershipId));
    });
  }

  /** Accept an invitation with its emailed token (single-use); activates the membership for `user`. */
  acceptInviteByToken(token: string, user: { userId: string; email: string }): Promise<{ organization_id: string; status: string }> {
    const tokenHash = sha256Hex(token);
    return this.db.transaction(async (tx) => {
      // An invited membership has no user_id, and no tenant is bound yet: resolve
      // the org through the SECURITY DEFINER lookup, bind it, then read under policy.
      const organizationId = await this.members.organizationIdForInviteToken(tx, tokenHash);
      if (organizationId === null) throw new InviteNotFoundError("Invite not found or already used");
      await tx.bindTenant(organizationId);
      const membership = await this.members.findInvitedByTokenHash(tx, tokenHash);
      if (!membership) throw new InviteNotFoundError("Invite not found or already used");
      await this.acceptMembership(tx, organizationId, membership.id, user);
      return { organization_id: organizationId, status: "active" };
    });
  }

  /**
   * Accept the pending invite for an address without its token — the seeding
   * path only (reference `accept_invite_by_email`), never an HTTP route.
   */
  acceptInviteByEmail(organizationId: string, user: { userId: string; email: string }): Promise<{ organization_id: string; status: string }> {
    return this.db.transaction(async (tx) => {
      await tx.bindTenant(organizationId);
      const membership = await this.members.findPendingInviteByEmail(tx, organizationId, user.email);
      if (!membership) throw new InviteNotFoundError("No pending invite for this email");
      await this.acceptMembership(tx, organizationId, membership.id, user);
      return { organization_id: organizationId, status: "active" };
    });
  }

  /** Flip an invited membership to active and emit the audit + outbox pair once. */
  private async acceptMembership(tx: Tx, organizationId: string, membershipId: string, user: { userId: string; email: string }): Promise<void> {
    await this.members.accept(tx, membershipId, user.userId, user.email);
    await this.audit.log(tx, {
      eventType: events.MEMBER_JOINED,
      organizationId,
      targetType: "membership",
      targetId: membershipId,
      diff: { email: user.email },
    });
    await this.outbox.append(tx, {
      eventType: events.MEMBER_JOINED,
      aggregateType: "membership",
      aggregateId: membershipId,
      organizationId,
      payload: { email: user.email },
    });
    await this.syncSeatGauge(tx, organizationId);
    await this.authz.invalidateUserPerms(tx, user.userId, organizationId);
  }

  updateMembership(membershipId: string, organizationId: string, patch: { roleKeys?: string[] | null; status?: string | null }): Promise<MembershipRead> {
    return this.db.transaction(async (tx) => {
      const membership = await this.scopedMembership(tx, membershipId, organizationId);
      const diff: Record<string, unknown> = {};
      if (patch.roleKeys != null) {
        await this.roles.detachAllFromMembership(tx, membershipId);
        for (const key of patch.roleKeys) await this.attachRole(tx, membershipId, organizationId, key);
        diff.roles = patch.roleKeys;
        await this.invalidatePerms(tx, membership.user_id, organizationId);
      }
      if (patch.status != null && patch.status !== membership.status) {
        await this.members.setStatus(tx, membershipId, patch.status);
        diff.status = { from: membership.status, to: patch.status };
      }
      if (Object.keys(diff).length > 0) {
        await this.audit.log(tx, { eventType: events.MEMBER_UPDATED, organizationId, targetType: "membership", targetId: membershipId, diff });
      }
      if ("status" in diff) {
        await this.syncSeatGauge(tx, organizationId);
        // Suspended members keep no tuples; reactivated ones get them back.
        await this.invalidatePerms(tx, membership.user_id, organizationId);
      }
      return toMembershipRead(await this.mustFindMembership(tx, membershipId));
    });
  }

  removeMember(membershipId: string, organizationId: string): Promise<void> {
    return this.db.transaction(async (tx) => {
      const membership = await this.scopedMembership(tx, membershipId, organizationId);
      const org = await this.mustFindOrganization(tx, organizationId);
      if (membership.user_id !== null && membership.user_id === org.owner_user_id) {
        throw new NotAMemberError("The owner cannot be removed; transfer ownership first");
      }
      await this.audit.log(tx, {
        eventType: events.MEMBER_REMOVED,
        organizationId,
        targetType: "membership",
        targetId: membershipId,
        diff: { email: membership.invited_email ?? membership.user_id },
      });
      await this.members.delete(tx, membershipId);
      await this.syncSeatGauge(tx, organizationId);
      // OpenFGA (when active): the removed member's tuples must go.
      await this.fga.queue(tx, organizationId, membership.user_id);
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** Create the default-plan subscription for a brand-new org (skipped, with a warning, when the catalog is not synced). */
  private async bootstrapSubscription(tx: Tx, organizationId: string): Promise<void> {
    const plan = await this.plans.findByKey(tx, this.settings.SYNAPSE_DEFAULT_PLAN_KEY, { includeArchived: true });
    if (!plan) {
      this.logger.warn(`default plan '${this.settings.SYNAPSE_DEFAULT_PLAN_KEY}' missing — no subscription bootstrapped for ${organizationId}`);
      return;
    }
    const now = new Date();
    await this.subscriptions.createSubscription(tx, {
      organizationId,
      plan,
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
    });
  }

  /** Drop the cached permissions of one member so the next request recomputes. */
  private async invalidatePerms(tx: Tx, userId: string | null, organizationId: string): Promise<void> {
    if (userId === null) return;
    await this.authz.invalidateUserPerms(tx, userId, organizationId);
  }

  /** `users` is a gauge: active members + pending invites, set after every change. */
  private async syncSeatGauge(tx: Tx, organizationId: string): Promise<void> {
    const active = await this.members.countByStatus(tx, organizationId, "active");
    const pending = await this.members.countByStatus(tx, organizationId, "invited");
    await this.usage.setGauge(tx, organizationId, "users", active + pending);
  }

  private async attachRole(tx: Tx, membershipId: string, organizationId: string, roleKey: string): Promise<void> {
    const role = await this.roles.findByKeyForOrganization(tx, roleKey, organizationId);
    if (!role) throw new RoleNotFoundError(`Role '${roleKey}' not found`);
    await this.roles.attachToMembership(tx, membershipId, role.id);
    await this.roles.recomputeMembershipPermissions(tx, membershipId);
  }

  private async mustFindOrganization(tx: Tx, organizationId: string) {
    const org = await this.orgs.findById(tx, organizationId);
    if (!org || org.deleted_at !== null) throw new OrganizationNotFoundError("Organization not found");
    return org;
  }

  private async mustFindMembership(tx: Tx, membershipId: string): Promise<MembershipRow> {
    const membership = await this.members.findById(tx, membershipId);
    if (!membership) throw new NotAMemberError("Membership not found");
    return membership;
  }

  /** The tenant's own row, or 404 — cross-tenant ids are indistinguishable from unknown ones. */
  private async scopedMembership(tx: Tx, membershipId: string, organizationId: string): Promise<MembershipRow> {
    const membership = await this.members.findById(tx, membershipId);
    if (!membership || membership.organization_id !== organizationId) throw new NotAMemberError("Membership not found");
    return membership;
  }
}
