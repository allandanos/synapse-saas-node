import { Logger } from "@nestjs/common";
import type { Settings } from "../../core/config";
import { FgaError } from "../../core/errors";

/** Milliseconds a single OpenFGA call may take before it counts as an outage. */
export const FGA_TIMEOUT_MS = 5000;

/** `user:<uuid>` / `organization:<uuid>` — OpenFGA object strings, not bare ids. */
export interface FgaTuple {
  readonly user: string;
  readonly relation: string;
  readonly object: string;
}

export function tupleKey(tuple: FgaTuple): Record<string, string> {
  return { user: tuple.user, relation: tuple.relation, object: tuple.object };
}

export function tupleId(tuple: FgaTuple): string {
  return `${tuple.user}|${tuple.relation}|${tuple.object}`;
}

export interface FgaClientOptions {
  url?: string;
  storeId?: string;
  modelId?: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Thin OpenFGA HTTP client (no SDK): check, write/delete tuples, list objects,
 * stores and models — `authorization/fga.py`.
 *
 * Every method throws `FgaError` on transport or non-2xx; the caller decides
 * the failure mode (`AuthorizationService` fails closed by default).
 */
export class FgaClient {
  private readonly logger = new Logger(FgaClient.name);
  readonly url: string;
  storeId: string;
  modelId: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(settings: Settings, options: FgaClientOptions = {}) {
    this.url = (options.url ?? settings.SYNAPSE_OPENFGA_URL).replace(/\/+$/, "");
    this.storeId = options.storeId ?? settings.SYNAPSE_OPENFGA_STORE_ID;
    this.modelId = options.modelId ?? settings.SYNAPSE_OPENFGA_MODEL_ID;
    this.token = options.apiToken ?? settings.SYNAPSE_OPENFGA_API_TOKEN;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.url && this.storeId);
  }

  // ── Checks ────────────────────────────────────────────────────────────────

  async check(user: string, relation: string, object: string): Promise<boolean> {
    const data = await this.post(this.storePath("/check"), this.withModel({ tuple_key: { user, relation, object } }));
    return Boolean((data as { allowed?: boolean }).allowed);
  }

  async listObjects(user: string, relation: string, objectType: string): Promise<string[]> {
    const data = await this.post(this.storePath("/list-objects"), this.withModel({ user, relation, type: objectType }));
    return ((data as { objects?: unknown[] }).objects ?? []).map((object) => String(object));
  }

  // ── Tuples ────────────────────────────────────────────────────────────────

  /**
   * Write and delete tuples. Duplicate writes and missing deletes are
   * tolerated — one request per tuple keeps the operation idempotent under
   * the outbox's retries.
   */
  async write(writes: readonly FgaTuple[] = [], deletes: readonly FgaTuple[] = []): Promise<void> {
    for (const tuple of writes) {
      try {
        await this.post(this.storePath("/write"), this.withModel({ writes: { tuple_keys: [tupleKey(tuple)] } }));
      } catch (error) {
        if (!this.bodyOf(error).includes("already exists")) throw error;
      }
    }
    for (const tuple of deletes) {
      try {
        await this.post(this.storePath("/write"), this.withModel({ deletes: { tuple_keys: [tupleKey(tuple)] } }));
      } catch (error) {
        // OpenFGA 1.x: "cannot delete a tuple which does not exist"; older builds: "not found".
        const body = this.bodyOf(error).toLowerCase();
        if (!body.includes("not found") && !body.includes("does not exist")) throw error;
      }
    }
  }

  async readTuples(object: string): Promise<FgaTuple[]> {
    const data = await this.post(this.storePath("/read"), { tuple_key: { object } });
    const tuples = (data as { tuples?: { key: FgaTuple }[] }).tuples ?? [];
    return tuples.map((entry) => ({ user: entry.key.user, relation: entry.key.relation, object: entry.key.object }));
  }

  // ── Stores + models ───────────────────────────────────────────────────────

  async createStore(name: string): Promise<string> {
    const data = await this.post("/stores", { name });
    return String((data as { id: string }).id);
  }

  async writeModel(model: unknown): Promise<string> {
    const data = await this.post(this.storePath("/authorization-models"), model as Record<string, unknown>);
    return String((data as { authorization_model_id: string }).authorization_model_id);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private withModel(body: Record<string, unknown>): Record<string, unknown> {
    return this.modelId ? { ...body, authorization_model_id: this.modelId } : body;
  }

  private storePath(suffix: string): string {
    if (!this.storeId) throw new FgaError("OpenFGA store id is not configured (SYNAPSE_OPENFGA_STORE_ID)");
    return `/stores/${this.storeId}${suffix}`;
  }

  private bodyOf(error: unknown): string {
    const extras = error instanceof FgaError ? error.extras : undefined;
    return typeof extras?.body === "string" ? extras.body : "";
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (!this.url) throw new FgaError("OpenFGA is not configured (SYNAPSE_OPENFGA_URL)");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FGA_TIMEOUT_MS),
      });
    } catch (error) {
      throw new FgaError(`OpenFGA unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    if (response.status >= 300) {
      this.logger.warn(`OpenFGA ${path} answered ${String(response.status)}`);
      throw new FgaError(`OpenFGA ${path} answered ${String(response.status)}`, { body: text.slice(0, 500) });
    }
    return text ? (JSON.parse(text) as unknown) : {};
  }
}
