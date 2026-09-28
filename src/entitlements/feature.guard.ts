import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Database } from "../core/db/database";
import { RequestContext } from "../core/request-context";
import { EntitlementsService } from "./entitlements.service";

export const REQUIRE_FEATURE = "synapse:require_feature";

/** `@RequireFeature("advanced_reports")` — enforced by `FeatureGuard` after tenant resolution. */
export const RequireFeature = (feature: string): MethodDecorator & ClassDecorator => SetMetadata(REQUIRE_FEATURE, feature);

/**
 * Feature gate (the reference's `require_feature` dependency): runs after
 * `TenantGuard`, checks the org's effective entitlements, and answers 403
 * `feature_not_entitled` with `feature`, `current_plan`, `available_in[]`,
 * `upgrade_url` when the plan lacks it. Later milestones gate routes with it
 * (`/v1/agents` → `agents`).
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: RequestContext,
    private readonly db: Database,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_FEATURE, [execution.getHandler(), execution.getClass()]);
    if (!feature) return true;
    const tenant = this.context.requireTenant();
    await this.db.transaction((tx) => this.entitlements.requireFeature(tx, tenant.organizationId, feature));
    return true;
  }
}
