import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PermissionDeniedError } from "../core/errors";
import { RequestContext } from "../core/request-context";
import { FlagsService } from "./flags.service";

export const REQUIRE_FLAG = "synapse:require_flag";

/**
 * `@RequireFlag("new-editor")` on a product route — the flag counterpart of
 * `@RequireFeature`. Flags gate code paths, not paid tiers, so a closed flag
 * is 403 `permission_denied` carrying the flag key instead of upgrade hints.
 */
export const RequireFlag = (flagKey: string): MethodDecorator & ClassDecorator => SetMetadata(REQUIRE_FLAG, flagKey);

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: RequestContext,
    private readonly flags: FlagsService,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const flagKey = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_FLAG, [execution.getHandler(), execution.getClass()]);
    if (!flagKey) return true;
    const tenant = this.context.requireTenant();
    const user = this.context.requireUser();
    if (!(await this.flags.isEnabled(tenant.organizationId, user.userId, flagKey))) {
      throw new PermissionDeniedError(`This action requires the '${flagKey}' feature flag to be enabled`, { flag: flagKey, reason: "feature_flag_disabled" });
    }
    return true;
  }
}
