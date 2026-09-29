import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../authorization/authorization.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { AgentsController } from "./agents.controller";
import { AgentsRepository } from "./agents.repository";
import { AgentsService } from "./agents.service";

/** Route family: the agent registry, gated by the `agents` entitlement. */
@Module({
  imports: [AuthorizationModule, TenancyModule, EntitlementsModule],
  controllers: [AgentsController],
  providers: [AgentsRepository, AgentsService],
  exports: [AgentsRepository, AgentsService],
})
export class AgentsModule {}
