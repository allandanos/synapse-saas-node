import { resolve } from "node:path";
import { z } from "zod";

/**
 * The SYNAPSE_* settings — same names and values as the reference
 * implementation wherever the concept exists, so one .env drives both.
 */
export const DEV_SECRET_KEY = "dev-only-secret-key-change-me-32-bytes-minimum!";

const emptyIsUndefined = (v: unknown): unknown => (typeof v === "string" && v.trim() === "" ? undefined : v);

const bool = z.preprocess((v) => {
  const value = emptyIsUndefined(v);
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return value;
}, z.boolean());

/** `a,b,c` or a JSON list, like the reference's NoDecode fields. */
const csv = z.preprocess((v) => {
  const value = emptyIsUndefined(v);
  if (typeof value !== "string") return value;
  const raw = value.trim();
  if (raw.startsWith("[")) return JSON.parse(raw) as unknown;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}, z.array(z.string()));

const positiveInt = z.coerce.number().int().positive();

/** An optional string setting: an empty value falls back to the default. */
const str = (fallback: string) => z.preprocess(emptyIsUndefined, z.string().default(fallback));

/** The catalog shipped with the port (`config/plans.yaml`, verbatim from the reference); products point SYNAPSE_PLANS_FILE at their own. */
export const DEFAULT_PLANS_FILE = resolve(__dirname, "..", "..", "config", "plans.yaml");

const schema = z.object({
  SYNAPSE_ENV: z.string().default("development"),
  SYNAPSE_VERSION: z.string().default("0.1.0"),
  SYNAPSE_SECRET_KEY: z.string().min(1).default(DEV_SECRET_KEY),
  SYNAPSE_DATABASE_URL: z.string().default("postgresql://synapse:synapse@localhost:5433/synapse"),
  SYNAPSE_DB_POOL_SIZE: positiveInt.default(10),
  SYNAPSE_WEB_ORIGIN: z.string().default("http://localhost:3000"),
  SYNAPSE_WEB_ORIGINS: csv.default([]),
  SYNAPSE_COOKIE_SECURE: bool.optional(),
  SYNAPSE_BILLING_PROVIDER: z.enum(["manual", "stripe", "paddle", "xendit", "paymongo"]).default("manual"),
  SYNAPSE_BILLING_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default("PHP"),
  // Provider credentials. A hosted provider selected without its secret is a
  // 409 `billing_provider_not_configured` from the registry, never a silent no-op.
  SYNAPSE_STRIPE_SECRET_KEY: str(""),
  SYNAPSE_STRIPE_WEBHOOK_SECRET: str(""),
  SYNAPSE_PADDLE_SECRET_KEY: str(""),
  SYNAPSE_PADDLE_WEBHOOK_SECRET: str(""),
  SYNAPSE_XENDIT_SECRET_KEY: str(""),
  SYNAPSE_XENDIT_WEBHOOK_TOKEN: str(""),
  SYNAPSE_PAYMONGO_SECRET_KEY: str(""),
  SYNAPSE_PAYMONGO_WEBHOOK_SECRET: str(""),
  /** Shared deployment token for `POST /v1/billing/webhooks/manual` (`X-Manual-Token`). */
  SYNAPSE_MANUAL_WEBHOOK_TOKEN: str(""),
  /** Pay-to text printed on manual invoices and their PDFs. */
  SYNAPSE_MANUAL_PAY_TO_INSTRUCTIONS: str(""),
  // Notifications: `smtp` sends through the relay below once a host is set.
  SYNAPSE_NOTIFIER: z.enum(["smtp", "noop"]).default("smtp"),
  SYNAPSE_SMTP_HOST: str(""),
  SYNAPSE_SMTP_PORT: positiveInt.default(1025),
  SYNAPSE_SMTP_FROM: str("synapse@localhost"),
  SYNAPSE_SMTP_USERNAME: str(""),
  SYNAPSE_SMTP_PASSWORD: str(""),
  SYNAPSE_SMTP_TLS: z.enum(["none", "starttls", "ssl"]).default("none"),
  /** Background jobs run in-process with the API (`pnpm worker` runs them alone). */
  SYNAPSE_WORKER_ENABLED: bool.default(true),
  SYNAPSE_AUDIT_RETENTION_DAYS: positiveInt.default(365),
  SYNAPSE_PLANS_FILE: z.preprocess(emptyIsUndefined, z.string().default(DEFAULT_PLANS_FILE)),
  SYNAPSE_AUTO_SYNC_PLANS: bool.default(true),
  SYNAPSE_DEFAULT_PLAN_KEY: z.string().min(1).default("free"),
  SYNAPSE_GRACE_ON_PAST_DUE: bool.default(true),
  SYNAPSE_IDENTITY_PROVIDER: z.enum(["local", "keycloak"]).default("local"),
  SYNAPSE_TENANT_ISOLATION: z.enum(["app", "app_and_rls"]).default("app"),
  SYNAPSE_ACCESS_TOKEN_TTL_MINUTES: positiveInt.default(15),
  SYNAPSE_REFRESH_TOKEN_TTL_DAYS: positiveInt.default(30),
  SYNAPSE_REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(10),
  SYNAPSE_MIGRATE_ON_START: bool.default(true),
  SYNAPSE_SEED_ON_START: bool.default(true),
  SYNAPSE_BOOTSTRAP_ADMIN_EMAIL: z.preprocess(emptyIsUndefined, z.string().email().optional()),
  SYNAPSE_BOOTSTRAP_ADMIN_PASSWORD: z.preprocess(emptyIsUndefined, z.string().min(10).optional()),
  PORT: positiveInt.default(8080),
});

type RawSettings = z.infer<typeof schema>;

export interface Settings extends RawSettings {
  readonly isProduction: boolean;
  readonly rlsEnabled: boolean;
  readonly cookieSecure: boolean;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly corsOrigins: readonly string[];
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  // The reference stores an asyncpg DSN; node-postgres wants the plain scheme.
  const normalised = {
    ...env,
    SYNAPSE_DATABASE_URL: env.SYNAPSE_DATABASE_URL?.replace("postgresql+asyncpg://", "postgresql://"),
  };
  const raw = schema.parse(normalised);
  const isProduction = raw.SYNAPSE_ENV === "production";
  if (isProduction && raw.SYNAPSE_SECRET_KEY.startsWith("dev-only-")) {
    throw new Error("Refusing to start in production: SYNAPSE_SECRET_KEY is the dev default");
  }
  const corsOrigins = [...new Set([raw.SYNAPSE_WEB_ORIGIN, ...raw.SYNAPSE_WEB_ORIGINS])];
  return {
    ...raw,
    isProduction,
    rlsEnabled: raw.SYNAPSE_TENANT_ISOLATION === "app_and_rls",
    cookieSecure: raw.SYNAPSE_COOKIE_SECURE ?? (isProduction || raw.SYNAPSE_WEB_ORIGIN.toLowerCase().startsWith("https://")),
    accessTokenTtlSeconds: raw.SYNAPSE_ACCESS_TOKEN_TTL_MINUTES * 60,
    refreshTokenTtlSeconds: raw.SYNAPSE_REFRESH_TOKEN_TTL_DAYS * 86_400,
    corsOrigins,
  };
}

export const SETTINGS = Symbol("SETTINGS");
export const PG_POOL = Symbol("PG_POOL");
