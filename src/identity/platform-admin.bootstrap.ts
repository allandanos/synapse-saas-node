import { Inject, Injectable, Logger } from "@nestjs/common";
import { SETTINGS, type Settings } from "../core/config";
import { Database } from "../core/db/database";
import { SecurityService } from "../core/security";
import { UsersRepository } from "./users.repository";

/**
 * Operator bootstrap: with SYNAPSE_BOOTSTRAP_ADMIN_EMAIL / _PASSWORD set, the
 * account is created (with that password) or, if it already exists, promoted
 * to platform admin at startup. Existing passwords are never rewritten.
 */
@Injectable()
export class PlatformAdminBootstrap {
  private readonly logger = new Logger(PlatformAdminBootstrap.name);

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly db: Database,
    private readonly security: SecurityService,
    private readonly users: UsersRepository,
  ) {}

  async run(): Promise<"created" | "promoted" | "unchanged" | "skipped"> {
    const email = this.settings.SYNAPSE_BOOTSTRAP_ADMIN_EMAIL;
    const password = this.settings.SYNAPSE_BOOTSTRAP_ADMIN_PASSWORD;
    if (!email || !password) return "skipped";
    const passwordHash = await this.security.hashPassword(password);
    const outcome = await this.db.transaction(async (tx) => {
      const existing = await this.users.findByEmail(tx, email);
      if (!existing) {
        await this.users.insert(tx, { email, passwordHash, displayName: "Operator", isPlatformAdmin: true });
        return "created" as const;
      }
      if (existing.is_platform_admin) return "unchanged" as const;
      await this.users.setPlatformAdmin(tx, existing.id, true);
      return "promoted" as const;
    });
    this.logger.log(`platform admin ${email}: ${outcome}`);
    return outcome;
  }
}
