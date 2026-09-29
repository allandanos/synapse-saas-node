import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { IdentityModule } from "../identity/identity.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { DevSeeder } from "./dev-seed";

/** The dev seeder is CLI-only — no controllers, no startup hook. */
@Module({
  imports: [EntitlementsModule, IdentityModule, TenancyModule],
  providers: [DevSeeder],
  exports: [DevSeeder],
})
export class SeedsModule {}
