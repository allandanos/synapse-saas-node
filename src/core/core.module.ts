import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { Pool, types } from "pg";
import { AuditWriter } from "./audit";
import { loadSettings, PG_POOL, SETTINGS, type Settings } from "./config";
import { Database } from "./db/database";
import { MigrationRunner } from "./db/migrations";
import { OutboxWriter } from "./outbox";
import { RequestContext } from "./request-context";
import { SecurityService } from "./security";

const OID_INT8 = 20;
const OID_TIMESTAMP = 1114;

/** `timestamp without time zone` columns hold UTC wall time; int8 counts fit a JS number. */
function configureTypeParsers(): void {
  types.setTypeParser(OID_INT8, (value) => Number(value));
  types.setTypeParser(OID_TIMESTAMP, (value) => new Date(`${value.replace(" ", "T")}Z`));
}

export function createPool(settings: Settings): Pool {
  configureTypeParsers();
  return new Pool({ connectionString: settings.SYNAPSE_DATABASE_URL, max: settings.SYNAPSE_DB_POOL_SIZE });
}

@Global()
@Module({
  providers: [
    { provide: SETTINGS, useFactory: () => loadSettings() },
    { provide: PG_POOL, inject: [SETTINGS], useFactory: createPool },
    RequestContext,
    Database,
    MigrationRunner,
    SecurityService,
    OutboxWriter,
    AuditWriter,
  ],
  exports: [SETTINGS, PG_POOL, RequestContext, Database, MigrationRunner, SecurityService, OutboxWriter, AuditWriter],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
