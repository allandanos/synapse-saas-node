import { BillingProviderError } from "../../core/errors";
import type { FetchLike } from "../providers";

/**
 * The providers' HTTP plumbing: plain `fetch` (injected, so tests point a
 * provider at a local stub server), JSON or form bodies, and a single failure
 * mode — `502 billing_provider_error` carrying the provider's own message.
 * Never a 500: an upstream refusal is not our bug.
 */
export interface ProviderHttpOptions {
  readonly fetchImpl: FetchLike;
  readonly baseUrl: string;
  readonly provider: string;
  readonly authHeader: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

export class ProviderHttp {
  constructor(private readonly options: ProviderHttpOptions) {}

  /** Form-encoded request (Stripe's dialect: `price_data[currency]=php`). */
  form(method: string, path: string, data: Record<string, unknown> = {}): Promise<JsonObject> {
    const body = new URLSearchParams(flattenForm(data)).toString();
    return this.send(method, path, body, "application/x-www-form-urlencoded");
  }

  json(method: string, path: string, body?: JsonValue): Promise<JsonObject> {
    return this.send(method, path, body === undefined ? undefined : JSON.stringify(body), "application/json");
  }

  private async send(method: string, path: string, body: string | undefined, contentType: string): Promise<JsonObject> {
    const headers: Record<string, string> = { Authorization: this.options.authHeader, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = contentType;
    let response: Response;
    try {
      response = await this.options.fetchImpl(`${this.options.baseUrl}${path}`, { method, headers, body });
    } catch (error) {
      throw new BillingProviderError(`${this.options.provider} API unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    if (response.status >= 400) {
      throw new BillingProviderError(`${this.options.provider} API error: ${providerMessage(text) ?? text}`);
    }
    try {
      return JSON.parse(text) as JsonObject;
    } catch {
      throw new BillingProviderError(`${this.options.provider} API returned a non-JSON body`);
    }
  }
}

/** Stripe reports `{error: {message}}`; the others put the detail in the body. */
function providerMessage(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

/** Nested objects → `parent[child]` keys; `undefined`/`null` values are dropped. */
export function flattenForm(data: Record<string, unknown>, prefix = ""): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    const full = prefix ? `${prefix}[${key}]` : key;
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value)) Object.assign(flat, flattenForm(value as Record<string, unknown>, full));
    else if (typeof value === "boolean") flat[full] = value ? "true" : "false";
    else flat[full] = String(value);
  }
  return flat;
}

/** HTTP Basic with the secret as the username and an empty password (Stripe, Xendit, PayMongo). */
export function basicAuth(secretKey: string): string {
  return `Basic ${Buffer.from(`${secretKey}:`, "utf8").toString("base64")}`;
}

/** Unix seconds → Date; anything else → null (providers omit fields freely). */
export function fromUnixSeconds(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
