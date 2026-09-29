import { Module } from "@nestjs/common";
import { TenancyModule } from "../tenancy/tenancy.module";
import { FeatureFlagCheckController, FeatureFlagsAdminController } from "./flags.controller";
import { FlagsRepository } from "./flags.repository";
import { FlagsService } from "./flags.service";
import { FeatureFlagGuard } from "./require-flag";

/** `/v1/feature-flags` — operator CRUD + overrides, and the tenant `check/{key}` read. */
@Module({
  imports: [TenancyModule],
  controllers: [FeatureFlagsAdminController, FeatureFlagCheckController],
  providers: [FlagsRepository, FlagsService, FeatureFlagGuard],
  exports: [FlagsRepository, FlagsService, FeatureFlagGuard],
})
export class FeatureFlagsModule {}
