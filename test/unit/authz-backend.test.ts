import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizationService } from "../../src/authorization/authorization.service";
import type { FgaSyncService } from "../../src/authorization/fga/sync";
import type { RolesRepository } from "../../src/authorization/roles.repository";
import { CacheRegistry } from "../../src/core/cache/cache.registry";
import { loadSettings } from "../../src/core/config";
import type { Database, Tx } from "../../src/core/db/database";
import type { RequestContext } from "../../src/core/request-context";
import { MapCacheBackend } from "../support/map-cache-backend";
import { StubProviderServer } from "../support/stub-provider-server";

const USER = "11111111-1111-1111-1111-111111111111";
const ORG = "22222222-2222-2222-2222-222222222222";
/** Port 1 is reserved and never listening: an OpenFGA outage on demand. */
const DEAD_STORE = "http://127.0.0.1:1";

/** The tuple sync is not under test here — only `queue` is ever reached. */
const NO_SYNC = { queue: (): Promise<void> => Promise.resolve() } as unknown as FgaSyncService;

/** A store that answers every check with `answer`, and records what it was asked. */
let answer = true;
const store = new StubProviderServer({
  "POST /stores/st/check": {
    get json(): unknown {
      return { allowed: answer };
    },
  },
});
let storeUrl = "";

const asked = (): { user: string; relation: string; object: string }[] =>
  store.calls.map((call) => (JSON.parse(call.body) as { tuple_key: { user: string; relation: string; object: string } }).tuple_key);

interface BuildOptions {
  url?: string;
  env?: Record<string, string>;
  rbacKeys?: string[] | undefined;
}

function build(options: BuildOptions = {}): { service: AuthorizationService; reads: () => number } {
  let reads = 0;
  const settings = loadSettings({
    SYNAPSE_OPENFGA_URL: options.url ?? storeUrl,
    SYNAPSE_OPENFGA_STORE_ID: "st",
    ...(options.env ?? {}),
  });
  const db = { transaction: <T,>(fn: (tx: Tx) => Promise<T>): Promise<T> => fn({} as Tx) } as unknown as Database;
  const roles = {
    permissionKeysForMember: (): Promise<string[] | undefined> => {
      reads += 1;
      return Promise.resolve(options.rbacKeys === undefined ? ["org:read"] : options.rbacKeys);
    },
  } as unknown as RolesRepository;
  const service = new AuthorizationService(db, roles, {} as RequestContext, NO_SYNC, new CacheRegistry(new MapCacheBackend()), settings);
  return { service, reads: () => reads };
}

beforeAll(async () => {
  storeUrl = await store.start();
});

afterAll(async () => {
  await store.stop();
});

describe("backend dispatch", () => {
  it("rbac is the default and never consults the store", async () => {
    const before = store.calls.length;
    const { service } = build();
    expect(await service.userCan(USER, ORG, "org:read")).toBe(true);
    expect(await service.userCan(USER, ORG, "org:delete")).toBe(false);
    expect(store.calls.length).toBe(before);
  });

  it("openfga asks the store with the catalog relation", async () => {
    const before = store.calls.length;
    answer = false;
    const { service } = build({ env: { SYNAPSE_AUTHZ_BACKEND: "openfga" } });
    expect(await service.userCan(USER, ORG, "org:delete")).toBe(false);
    expect(asked().slice(before)).toEqual([{ user: `user:${USER}`, relation: "can_org_delete", object: `organization:${ORG}` }]);
    answer = true;
  });

  it("caches decisions per (user, object) and asks again for another permission", async () => {
    const before = store.calls.length;
    const { service } = build({ env: { SYNAPSE_AUTHZ_BACKEND: "openfga" } });
    await service.userCan(USER, ORG, "org:read");
    await service.userCan(USER, ORG, "org:read");
    expect(store.calls.length - before).toBe(1);
    await service.userCan(USER, ORG, "org:update"); // a different question
    expect(store.calls.length - before).toBe(2);
  });

  it("a membership change drops every decision for that (user, org) at once", async () => {
    const before = store.calls.length;
    const { service } = build({ env: { SYNAPSE_AUTHZ_BACKEND: "openfga" } });
    await service.userCan(USER, ORG, "org:read");
    await service.userCan(USER, ORG, "org:update");
    expect(store.calls.length - before).toBe(2);
    const tx = { afterCommit: (): void => undefined, deferBump: (): void => undefined } as unknown as Tx;
    await service.invalidateUserPerms(tx, USER, ORG);
    await service.userCan(USER, ORG, "org:read");
    await service.userCan(USER, ORG, "org:update");
    expect(store.calls.length - before).toBe(4);
  });

  it("answers resource-level questions on any object type", async () => {
    const before = store.calls.length;
    const { service } = build({ env: { SYNAPSE_AUTHZ_BACKEND: "openfga" } });
    expect(await service.userCanOn(USER, "project:manage", "project", "p-1")).toBe(true);
    expect(asked().slice(before)).toEqual([{ user: `user:${USER}`, relation: "can_project_manage", object: "project:p-1" }]);
  });

  it("the rbac backend refuses non-organization resources", () => {
    const { service } = build();
    expect(() => service.userCanOn(USER, "project:manage", "project", "p-1")).toThrow(/openfga backend/);
  });

  it("the rbac backend still answers organization objects", async () => {
    const { service } = build();
    expect(await service.userCanOn(USER, "org:read", "organization", ORG)).toBe(true);
  });
});

describe("failure modes", () => {
  const outage = (mode: string): BuildOptions => ({
    url: DEAD_STORE,
    env: { SYNAPSE_AUTHZ_BACKEND: "openfga", SYNAPSE_OPENFGA_FAIL_MODE: mode },
  });

  it("closed denies even where RBAC would allow", async () => {
    const { service } = build(outage("closed"));
    expect(await service.userCan(USER, ORG, "org:read")).toBe(false);
  });

  it("rbac falls back for organization objects", async () => {
    const { service } = build(outage("rbac"));
    expect(await service.userCan(USER, ORG, "org:read")).toBe(true);
    expect(await service.userCan(USER, ORG, "org:delete")).toBe(false);
  });

  it("rbac never falls back for a non-organization object — there is nothing to fall back to", async () => {
    const { service } = build(outage("rbac"));
    expect(await service.userCanOn(USER, "project:read", "project", "p-1")).toBe(false);
  });

  it("an outage is never cached, so recovery is immediate", async () => {
    const caches = new CacheRegistry(new MapCacheBackend());
    const db = { transaction: <T,>(fn: (tx: Tx) => Promise<T>): Promise<T> => fn({} as Tx) } as unknown as Database;
    const roles = { permissionKeysForMember: (): Promise<string[]> => Promise.resolve(["org:read"]) } as unknown as RolesRepository;
    const make = (url: string): AuthorizationService =>
      new AuthorizationService(
        db,
        roles,
        {} as RequestContext,
        NO_SYNC,
        caches, // the SAME cache across both: only the store's reachability changes
        loadSettings({ SYNAPSE_AUTHZ_BACKEND: "openfga", SYNAPSE_OPENFGA_URL: url, SYNAPSE_OPENFGA_STORE_ID: "st" }),
      );
    expect(await make(DEAD_STORE).userCan(USER, ORG, "org:read")).toBe(false);
    expect(await make(storeUrl).userCan(USER, ORG, "org:read")).toBe(true); // recovered ⇒ asked again
  });
});

describe("the RBAC permission set", () => {
  it("is cached, and invalidateUserPerms drops it", async () => {
    const { service, reads } = build({ rbacKeys: ["org:read", "member:read"] });
    expect([...(await service.permissionKeysFor(USER, ORG))].sort()).toEqual(["member:read", "org:read"]);
    await service.permissionKeysFor(USER, ORG);
    expect(reads()).toBe(1);

    const tx = { afterCommit: (): void => undefined, deferBump: (): void => undefined } as unknown as Tx;
    await service.invalidateUserPerms(tx, USER, ORG);
    await service.permissionKeysFor(USER, ORG);
    expect(reads()).toBe(2);
  });

  it("never caches an empty set (a non-member must not be memoised as one)", async () => {
    const { service, reads } = build({ rbacKeys: undefined });
    // `undefined` from the repository means "no active membership"
    const empty = build({ rbacKeys: [] });
    expect(await empty.service.permissionKeysFor(USER, ORG)).toEqual(new Set());
    await empty.service.permissionKeysFor(USER, ORG);
    expect(empty.reads()).toBe(2);
    expect(reads()).toBe(0);
  });
});
