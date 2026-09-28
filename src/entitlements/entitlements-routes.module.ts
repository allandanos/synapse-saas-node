import { Module } from "@nestjs/common";
import { TenancyModule } from "../tenancy/tenancy.module";
import { AdminEntitlementsController, EntitlementsController } from "./entitlements.controller";
import { EntitlementsModule } from "./entitlements.module";

/** `/v1/entitlements` (tenant) + `/v1/admin/orgs/{org_id}/entitlements*` (platform operator). */
@Module({
  imports: [EntitlementsModule, TenancyModule],
  controllers: [EntitlementsController, AdminEntitlementsController],
})
export class EntitlementsRoutesModule {}
