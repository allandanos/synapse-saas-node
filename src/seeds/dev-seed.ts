import { Inject, Injectable, Logger } from "@nestjs/common";
import { SETTINGS, type Settings } from "../core/config";
import { Database } from "../core/db/database";
import { SecurityService } from "../core/security";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { UsersRepository } from "../identity/users.repository";
import { TenancyService } from "../tenancy/tenancy.service";

/**
 * Development seed: the demo org plus one user per system role, so the console
 * is clickable (and the e2e journeys have a platform operator) the moment the
 * stack is up. NEVER runs in production — the caller refuses there, and `run()`
 * is a no-op when the owner already exists.
 */
export const DEV_PASSWORD = "password123";

/** The demo org's `users` limit grant — the free plan ships 3 seats, the seed needs 5. */
export const DEV_SEAT_LIMIT = 10;

export const DEV_ORG_NAME = "Acme Corporation";
export const DEV_ORG_SLUG = "acme";

/**
 * One demo user per system role. The owner also carries `is_platform_admin` so
 * the admin console is reachable in dev. Domain is example.com (RFC 2606) —
 * `.test` is a special-use TLD that email validation rejects, which would make
 * the demo users impossible to log in. Emails are load-bearing: extend, never rename.
 */
export const DEV_ROLE_USERS: ReadonlyArray<readonly [email: string, roleKey: string]> = [
  ["owner@acme.example.com", "owner"],
  ["admin@acme.example.com", "admin"],
  ["billing@acme.example.com", "billing"],
  ["developer@acme.example.com", "developer"],
  ["member@acme.example.com", "member"],
];

export const DEV_OWNER_EMAIL = "owner@acme.example.com";

function displayNameFor(roleKey: string): string {
  return `Acme ${roleKey.charAt(0).toUpperCase()}${roleKey.slice(1)}`;
}

@Injectable()
export class DevSeeder {
  private readonly logger = new Logger(DevSeeder.name);

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly db: Database,
    private readonly security: SecurityService,
    private readonly users: UsersRepository,
    private readonly tenancy: TenancyService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Idempotent: the owner's presence is the marker, exactly like the reference. */
  async run(): Promise<"seeded" | "skipped"> {
    if (this.settings.isProduction) {
      throw new Error("Refusing to seed demo data: SYNAPSE_ENV is production");
    }
    const existing = await this.db.transaction((tx) => this.users.findByEmail(tx, DEV_OWNER_EMAIL));
    if (existing) {
      this.logger.log("dev seed skipped: already seeded");
      return "skipped";
    }

    const passwordHash = await this.security.hashPassword(DEV_PASSWORD);

    // Owner first: creating the org attaches the owner role and bootstraps the
    // free subscription + seat gauge through the normal create-org path.
    const owner = await this.db.transaction((tx) =>
      this.users.insert(tx, { email: DEV_OWNER_EMAIL, passwordHash, displayName: displayNameFor("owner"), isPlatformAdmin: true }),
    );
    const org = await this.tenancy.createOrganization({ name: DEV_ORG_NAME, slug: DEV_ORG_SLUG, ownerUserId: owner.id });

    // One user per remaining system role, invited by the owner then auto-accepted.
    for (const [email, roleKey] of DEV_ROLE_USERS) {
      if (email === DEV_OWNER_EMAIL) continue;
      const user = await this.db.transaction((tx) => this.users.insert(tx, { email, passwordHash, displayName: displayNameFor(roleKey) }));
      await this.tenancy.inviteMember({ organizationId: org.id, email, roleKeys: [roleKey], organizationName: org.name, enforceSeatLimit: false });
      await this.tenancy.acceptInviteByEmail(org.id, { userId: user.id, email });
    }

    // Five demo users on a free plan (3 seats) would show an over-quota seat
    // meter out of the box; grant the seats the way an operator would.
    await this.db.transaction((tx) =>
      this.entitlements.grant(tx, org.id, {
        featureKey: "limit:users",
        source: "override", // operator-style grant (the allowed sources are constrained)
        limitValue: DEV_SEAT_LIMIT,
        note: "dev seed: one demo user per system role",
        createdByUserId: owner.id,
      }),
    );

    this.logger.log(`dev seeded: org ${org.slug}, roles ${DEV_ROLE_USERS.map(([, role]) => role).join(", ")}`);
    return "seeded";
  }
}
