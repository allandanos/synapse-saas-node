import { randomBytes, randomUUID } from "node:crypto";

/**
 * ID generation and slug utilities (transliterated from the reference).
 * UUIDv7 for high-volume, time-ordered rows (outbox, audit); UUIDv4 otherwise.
 */

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "www", "api", "app", "admin", "mail", "smtp", "ftp", "sftp", "ssh", "support", "help", "billing",
  "checkout", "pay", "login", "signin", "signup", "register", "logout", "static", "assets", "cdn",
  "docs", "status", "health", "platform", "system", "root", "synapse", "dashboard", "console", "portal",
]);

const SLUG_RE = /[^a-z0-9]+/g;
const VALID_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newUuid(): string {
  return randomUUID();
}

/** RFC 9562 UUIDv7: 48-bit unix-ms timestamp + random. */
export function uuidV7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(now);
  for (let i = 5; i >= 0; i -= 1) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidV7Timestamp(value: string): Date {
  return new Date(Number.parseInt(value.replace(/-/g, "").slice(0, 12), 16));
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Lowercase [a-z0-9-] slug, collapsed separators, trimmed, length-capped. */
export function slugify(text: string, maxLength = 48): string {
  const collapsed = text.toLowerCase().replace(SLUG_RE, "-").replace(/^-+|-+$/g, "");
  return collapsed.replace(/-{2,}/g, "-").slice(0, maxLength).replace(/^-+|-+$/g, "");
}

export function isValidSlug(slug: string): boolean {
  return VALID_SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

/** Slug with a short random suffix — used when the preferred slug is taken. */
export function uniqueSlug(base: string): string {
  const suffix = randomBytes(3).toString("hex");
  const stem = slugify(base).slice(0, 39).replace(/^-+|-+$/g, "") || "org";
  return `${stem}-${suffix}`;
}
