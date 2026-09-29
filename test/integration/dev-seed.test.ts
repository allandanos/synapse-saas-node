import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../../src/core/db/database";
import { DEV_ORG_SLUG, DEV_OWNER_EMAIL, DEV_PASSWORD, DEV_ROLE_USERS, DEV_SEAT_LIMIT, DevSeeder } from "../../src/seeds/dev-seed";
import { type Harness, startHarness, stopHarness, TEST_DB } from "./harness";

/**
 * The dev seed is the e2e stack's fixture: the console journeys log in as its
 * owner (the platform operator) and the demo org is what a click-through shows.
 * Every property the reference's `seeds/dev_seed.py` guarantees is asserted here.
 */
const maybe = TEST_DB ? describe : describe.skip;

maybe("dev seed", () => {
  let h: Harness;
  let seeder: DevSeeder;
  let db: Database;

  beforeAll(async () => {
    h = await startHarness();
    seeder = h.app.get(DevSeeder);
    db = h.app.get(Database);
  });
  afterAll(async () => {
    await stopHarness(h);
  });

  it("creates one user per system role, all logging in with the documented password", async () => {
    expect(await seeder.run()).toBe("seeded");

    for (const [email] of DEV_ROLE_USERS) {
      const login = await h.http.post("/v1/auth/login").send({ email, password: DEV_PASSWORD });
      expect(login.status, `${email}: ${login.text}`).toBe(200);
      expect(login.body.user.display_name).toMatch(/^Acme /);
    }
  });

  it("marks only the owner a platform admin", async () => {
    const rows = await db.transaction((tx) =>
      tx.rows<{ email: string; is_platform_admin: boolean }>(`SELECT email, is_platform_admin FROM users ORDER BY email`),
    );
    const flags = new Map(rows.map((r) => [r.email, r.is_platform_admin]));
    for (const [email] of DEV_ROLE_USERS) {
      expect(flags.get(email), email).toBe(email === DEV_OWNER_EMAIL);
    }
  });

  it("puts every user in the Acme org with its own role, through the normal invite path", async () => {
    const login = await h.http.post("/v1/auth/login").send({ email: DEV_OWNER_EMAIL, password: DEV_PASSWORD });
    const bearer = { Authorization: `Bearer ${String(login.body.tokens.access_token)}` };

    const me = await h.http.get("/v1/auth/me").set(bearer);
    expect(me.status, me.text).toBe(200);
    const org = (me.body.orgs as { id: string; slug: string; name: string; role_keys: string[] }[])[0];
    expect(org.slug).toBe(DEV_ORG_SLUG);
    expect(org.name).toBe("Acme Corporation");
    expect(org.role_keys).toEqual(["owner"]);

    const members = await h.http.get("/v1/orgs/current/members").set({ ...bearer, "X-Org-Id": org.id });
    expect(members.status, members.text).toBe(200);
    const rows = members.body.data as { email: string | null; status: string; role_keys: string[] }[];
    const byEmail = new Map(rows.map((m) => [m.email, m]));
    expect(byEmail.size).toBe(DEV_ROLE_USERS.length);
    for (const [email, roleKey] of DEV_ROLE_USERS) {
      expect(byEmail.get(email)?.status, email).toBe("active");
      expect(byEmail.get(email)?.role_keys, email).toEqual([roleKey]);
    }
  });

  it("gives the demo org the default subscription the create-org path bootstraps", async () => {
    const login = await h.http.post("/v1/auth/login").send({ email: DEV_OWNER_EMAIL, password: DEV_PASSWORD });
    const bearer = { Authorization: `Bearer ${String(login.body.tokens.access_token)}` };
    const me = await h.http.get("/v1/auth/me").set(bearer);
    const orgId = (me.body.orgs as { id: string }[])[0].id;

    const subscription = await h.http.get("/v1/subscription").set({ ...bearer, "X-Org-Id": orgId });
    expect(subscription.status, subscription.text).toBe(200);
    expect(subscription.body.subscription.plan.key).toBe("free");
    expect(subscription.body.subscription.status).toBe("active");
  });

  it("grants the demo org its seats — five users would not fit the free plan's three", async () => {
    const login = await h.http.post("/v1/auth/login").send({ email: DEV_OWNER_EMAIL, password: DEV_PASSWORD });
    const bearer = { Authorization: `Bearer ${String(login.body.tokens.access_token)}` };
    const me = await h.http.get("/v1/auth/me").set(bearer);
    const orgId = (me.body.orgs as { id: string }[])[0].id;

    const entitlements = await h.http.get("/v1/entitlements").set({ ...bearer, "X-Org-Id": orgId });
    expect(entitlements.status, entitlements.text).toBe(200);
    const seats = entitlements.body.limits.users.value as number;
    expect(seats).toBe(DEV_SEAT_LIMIT);
    expect(seats).toBeGreaterThanOrEqual(DEV_ROLE_USERS.length);
  });

  it("is idempotent — a second run is a no-op", async () => {
    expect(await seeder.run()).toBe("skipped");
    const count = await db.transaction((tx) => tx.one<{ count: number }>(`SELECT count(*)::int AS count FROM organizations`));
    expect(count?.count).toBe(1);
  });

});
