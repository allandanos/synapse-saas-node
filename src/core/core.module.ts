import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { Pool, types } from "pg";
import { AuditWriter } from "./audit";
import { CACHE_BACKEND, CacheRegistry, createCacheBackend } from "./cache/cache.registry";
import type { CacheBackend } from "./cache/backend";
import { loadSettings, PG_POOL, SETTINGS, type Settings } from "./config";
import { Database } from "./db/database";
import { MigrationRunner } from "./db/migrations";
import { OutboxWriter } from "./outbox";
import { RequestContext } from "./request-context";
import { RateLimiter } from "./rate-limiter";
import { RouteTable } from "./route-table";
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
  imports: [DiscoveryModule],
  providers: [
    { provide: SETTINGS, useFactory: () => loadSettings() },
    { provide: PG_POOL, inject: [SETTINGS], useFactory: createPool },
    { provide: CACHE_BACKEND, inject: [SETTINGS], useFactory: createCacheBackend },
    CacheRegistry,
    RequestContext,
    Database,
    MigrationRunner,
    SecurityService,
    OutboxWriter,
    AuditWriter,
    RouteTable,
    RateLimiter,
  ],
  exports: [SETTINGS, PG_POOL, CACHE_BACKEND, CacheRegistry, RequestContext, Database, MigrationRunner, SecurityService, OutboxWriter, AuditWriter, RouteTable, RateLimiter],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CACHE_BACKEND) private readonly cache: CacheBackend,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.cache.close();
    await this.pool.end();
  }
}
