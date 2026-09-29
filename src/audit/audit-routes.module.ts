import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../authorization/authorization.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { AuditController } from "./audit.controller";
import { AuditRepository } from "./audit.repository";

/** `/v1/audit` — a read over the rows the core `AuditWriter` already writes. */
@Module({
  imports: [AuthorizationModule, TenancyModule],
  controllers: [AuditController],
  providers: [AuditRepository],
  exports: [AuditRepository],
})
export class AuditRoutesModule {}
