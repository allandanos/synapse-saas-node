import { Module } from "@nestjs/common";
import { TenancyModule } from "../tenancy/tenancy.module";
import { AuthorizationModule } from "./authorization.module";
import { RolesController } from "./roles.controller";

/** The `/v1/roles` + `/v1/permissions` route family (needs the tenant guard, hence separate from the engine). */
@Module({
  imports: [AuthorizationModule, TenancyModule],
  controllers: [RolesController],
})
export class RolesModule {}
