import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProbeController } from "../src/api/probe.controller";
import { loadSettings, SETTINGS } from "../src/core/config";
import { Database } from "../src/core/db/database";

describe("probes + meta (no database)", () => {
  let app: INestApplication;
  let dbUp = true;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: SETTINGS, useValue: loadSettings({ SYNAPSE_TENANT_ISOLATION: "app_and_rls" }) },
        {
          provide: Database,
          useValue: {
            ping: async () => {
              if (!dbUp) throw new Error("down");
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
    expect(res.body).toEqual({ status: "ok", checks: { database: "ok", redis: "not_configured" } });
    dbUp = false;
    res = await request(app.getHttpServer()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.checks.database).toMatch(/^error/);
    dbUp = true;
  });

  it("meta describes the deployment with the reference's keys", async () => {
    const res = await request(app.getHttpServer()).get("/v1/meta");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      framework: "synapse-saas",
      version: "0.1.0",
      billing_provider: "manual",
      identity_provider: "local",
      tenant_isolation: "app_and_rls",
    });
  });
});
