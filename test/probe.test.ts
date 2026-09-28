import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProbeController } from "../src/api/probe.controller";
import { loadSettings, PG_POOL, SETTINGS } from "../src/core/config";

describe("probes + meta (milestone 1 slice)", () => {
  let app: INestApplication;
  let dbUp = true;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: SETTINGS, useValue: loadSettings({ SYNAPSE_TENANT_ISOLATION: "app_and_rls" }) },
        {
          provide: PG_POOL,
          useValue: {
            query: async () => {
              if (!dbUp) throw new Error("down");
              return { rows: [{ "?column?": 1 }] };
            },
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("healthz is public and ok", async () => {
    const res = await request(app.getHttpServer()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("readyz reports the database and flips to 503", async () => {
    let res = await request(app.getHttpServer()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.checks.database).toBe("ok");
    dbUp = false;
    res = await request(app.getHttpServer()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "degraded", checks: { database: "error" } });
    dbUp = true;
  });

  it("meta describes the deployment with the reference's keys", async () => {
    const res = await request(app.getHttpServer()).get("/v1/meta");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      version: "0.1.0",
      billing_provider: "manual",
      identity_provider: "local",
      tenant_isolation: "app_and_rls",
    });
  });

  it("normalises the reference's asyncpg DSN", () => {
    const s = loadSettings({ SYNAPSE_DATABASE_URL: "postgresql+asyncpg://u:p@h:5432/db" });
    expect(s.SYNAPSE_DATABASE_URL).toBe("postgresql://u:p@h:5432/db");
  });
});
