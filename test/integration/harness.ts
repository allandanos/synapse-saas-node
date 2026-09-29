import "reflect-metadata";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";
import { expect } from "vitest";
import { AppModule } from "../../src/app.module";
import { SystemSeeder } from "../../src/authorization/system-seed";
import { SETTINGS, type Settings } from "../../src/core/config";
import { MigrationRunner } from "../../src/core/db/migrations";
import { PlatformAdminBootstrap } from "../../src/identity/platform-admin.bootstrap";
import { configureHttp } from "../../src/main";
import { SeedsModule } from "../../src/seeds/seeds.module";
import { PlanCatalogSync } from "../../src/subscriptions/catalog-sync";

/**
 * Shared bootstrap for the DB-backed suites: the whole app over supertest
 * against SYNAPSE_TEST_DATABASE_URL (a scratch database — every table is
 * truncated first), migrated, seeded (permissions, system roles, plan
 * catalog) and with the bootstrap platform admin. Suites skip without the URL
 * so `pnpm test` stays green without a database; `pnpm test:db` sets it.
 */
export const TEST_DB = process.env.SYNAPSE_TEST_DATABASE_URL;

// Node >= 19 keeps sockets alive by default; one connection per request keeps the journeys deterministic.
http.globalAgent = new http.Agent({ keepAlive: false });

export const ADMIN_EMAIL = "operator@platform.example.com";
export const ADMIN_PASSWORD = "operator-password-12345";
export const PASSWORD = "conformance-password-12345";

export const uid = (): string => Math.random().toString(16).slice(2, 10);

export interface Harness {
  app: NestExpressApplication;
  pool: Pool;
  http: ReturnType<typeof request>;
}

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`DO $$ DECLARE r RECORD; BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations') LOOP
      EXECUTE format('TRUNCATE TABLE %I CASCADE', r.tablename);
    END LOOP; END $$;`);
}

export async function startHarness(): Promise<Harness> {
  process.env.SYNAPSE_DATABASE_URL = TEST_DB;
  process.env.SYNAPSE_DB_POOL_SIZE = process.env.SYNAPSE_DB_POOL_SIZE ?? "20";
  process.env.SYNAPSE_BOOTSTRAP_ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.SYNAPSE_BOOTSTRAP_ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.SYNAPSE_TENANT_ISOLATION = process.env.SYNAPSE_TEST_TENANT_ISOLATION ?? "app";
  // File journeys write real bytes; keep them out of the working tree.
  process.env.SYNAPSE_STORAGE_ROOT = process.env.SYNAPSE_STORAGE_ROOT ?? join(tmpdir(), `synapse-node-storage-${String(process.pid)}`);
  // The journeys drive `JobsService` explicitly; the in-process cadence would
  // otherwise race them (and keep timers alive past the suite).
  process.env.SYNAPSE_WORKER_ENABLED = "false";
  // The suites register hundreds of accounts from one address, and with a real
  // SYNAPSE_REDIS_URL the window is shared across files and consecutive runs.
  // A suite that IS about rate limiting sets its own limits before calling us.
  process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IP ??= "100000";
  process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IDENTITY ??= "100000";
  // SeedsModule is CLI-only in production; the harness adds it so the dev-seed suite can resolve it.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, SeedsModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureHttp(app, app.get<Settings>(SETTINGS));
  await app.get(MigrationRunner).run();
  const pool = new Pool({ connectionString: TEST_DB, max: 2 });
  await truncateAll(pool);
  await app.get(SystemSeeder).seed();
  await app.get(PlanCatalogSync).syncFromFile();
  await app.get(PlatformAdminBootstrap).run();
  await app.init();
  return { app, pool, http: request(app.getHttpServer()) };
}

export async function stopHarness(h: Harness | undefined): Promise<void> {
  await h?.pool.end();
  await h?.app.close();
}

export interface Registered {
  email: string;
  access: string;
  refresh: string;
  userId: string;
}

export async function register(h: Harness, label: string): Promise<Registered> {
  const email = `${label}-${uid()}@example.com`;
  const res = await h.http.post("/v1/auth/register").send({ email, password: PASSWORD, display_name: label });
  expect(res.status, res.text).toBe(201);
  return { email, access: res.body.tokens.access_token, refresh: res.body.tokens.refresh_token, userId: res.body.user.id };
}

export interface TenantFixture extends Registered {
  orgId: string;
  slug: string;
  headers: { Authorization: string; "X-Org-Id": string };
  bearer: { Authorization: string };
}

/** A fresh owner + org, like the conformance suite's `tenant` fixture. */
export async function makeTenant(h: Harness, label = "owner"): Promise<TenantFixture> {
  const user = await register(h, label);
  const slug = `org-${uid()}`;
  const org = await h.http.post("/v1/orgs").set("Authorization", `Bearer ${user.access}`).send({ name: `Org ${slug}`, slug });
  expect(org.status, org.text).toBe(201);
  const bearer = { Authorization: `Bearer ${user.access}` };
  return { ...user, orgId: org.body.id, slug, headers: { ...bearer, "X-Org-Id": org.body.id }, bearer };
}

export async function platformHeaders(h: Harness): Promise<{ Authorization: string }> {
  const login = await h.http.post("/v1/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(login.status, login.text).toBe(200);
  return { Authorization: `Bearer ${login.body.tokens.access_token}` };
}
