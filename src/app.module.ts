import { Module } from "@nestjs/common";
import { Pool } from "pg";
import { ProbeController } from "./api/probe.controller";
import { loadSettings, PG_POOL, SETTINGS } from "./core/config";

@Module({
  controllers: [ProbeController],
  providers: [
    { provide: SETTINGS, useFactory: () => loadSettings() },
    {
      provide: PG_POOL,
      inject: [SETTINGS],
      useFactory: (settings: ReturnType<typeof loadSettings>) =>
        new Pool({ connectionString: settings.SYNAPSE_DATABASE_URL, max: 10 }),
    },
  ],
})
export class AppModule {}
