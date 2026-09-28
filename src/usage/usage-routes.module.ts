import { Module } from "@nestjs/common";
import { TenancyModule } from "../tenancy/tenancy.module";
import { UsageController } from "./usage.controller";
import { UsageModule } from "./usage.module";

/** The `/v1/usage/*` route family. */
@Module({
  imports: [UsageModule, TenancyModule],
  controllers: [UsageController],
})
export class UsageRoutesModule {}
