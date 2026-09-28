import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../authorization/authorization.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeysRepository } from "./api-keys.repository";
import { ApiKeysService } from "./api-keys.service";

@Module({
  imports: [AuthorizationModule, TenancyModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysRepository, ApiKeysService],
  exports: [ApiKeysRepository, ApiKeysService],
})
export class ApiKeysModule {}
