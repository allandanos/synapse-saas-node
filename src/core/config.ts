import { z } from "zod";

/**
 * The SYNAPSE_* settings — same names and values as the reference
 * implementation wherever the concept exists, so one .env drives both.
 */
const schema = z.object({
  SYNAPSE_VERSION: z.string().default("0.1.0"),
  SYNAPSE_DATABASE_URL: z.string().default("postgresql://synapse:synapse@localhost:5433/synapse"),
  SYNAPSE_BILLING_PROVIDER: z.enum(["manual", "stripe", "paddle", "xendit", "paymongo"]).default("manual"),
  SYNAPSE_IDENTITY_PROVIDER: z.enum(["local", "keycloak"]).default("local"),
  SYNAPSE_TENANT_ISOLATION: z.enum(["app", "app_and_rls"]).default("app"),
  PORT: z.coerce.number().int().positive().default(8080),
});

export type Settings = z.infer<typeof schema>;

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  // The reference stores an asyncpg DSN; node-postgres wants the plain scheme.
  const normalised = { ...env, SYNAPSE_DATABASE_URL: env.SYNAPSE_DATABASE_URL?.replace("postgresql+asyncpg://", "postgresql://") };
  return schema.parse(normalised);
}

export const SETTINGS = Symbol("SETTINGS");
export const PG_POOL = Symbol("PG_POOL");
