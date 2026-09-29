import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A Fernet codec (spec version 0x80) in ~60 lines of `node:crypto`.
 *
 * Webhook endpoint secrets are Fernet-encrypted at rest under
 * `SYNAPSE_SECRET_KEY`, and the ports must be interchangeable: an endpoint
 * created by the Python reference has to be deliverable by this server and
 * vice versa. Implementing the format is therefore part of the contract, not
 * a library choice.
 *
 * Token layout (then base64url-encoded):
 *   0x80 | timestamp (8 bytes, big-endian seconds) | IV (16) |
 *   AES-128-CBC ciphertext (PKCS#7) | HMAC-SHA256 over everything above (32)
 *
 * The 32-byte key splits into a 16-byte signing key and a 16-byte encryption
 * key. Rotating `SYNAPSE_SECRET_KEY` invalidates every stored secret.
 */

const VERSION = 0x80;
const IV_LENGTH = 16;
const HMAC_LENGTH = 32;
const HEADER_LENGTH = 1 + 8 + IV_LENGTH;

export class FernetError extends Error {}

/**
 * The reference derives the key as `urlsafe_b64encode(sha256(secret_key))`,
 * which Fernet decodes straight back to those 32 bytes — so hash and split.
 */
export function fernetKey(secretKey: string): { signingKey: Buffer; encryptionKey: Buffer } {
  const digest = createHash("sha256").update(secretKey, "utf8").digest();
  return { signingKey: digest.subarray(0, 16), encryptionKey: digest.subarray(16, 32) };
}

export function fernetEncrypt(plaintext: string, secretKey: string, now = new Date(), iv = randomBytes(IV_LENGTH)): Buffer {
  const { signingKey, encryptionKey } = fernetKey(secretKey);
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt8(VERSION, 0);
  header.writeBigUInt64BE(BigInt(Math.floor(now.getTime() / 1000)), 1);
  iv.copy(header, 9);

  const cipher = createCipheriv("aes-128-cbc", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const body = Buffer.concat([header, ciphertext]);
  const mac = createHmac("sha256", signingKey).update(body).digest();
  return Buffer.from(base64Url(Buffer.concat([body, mac])), "utf8");
}

export function fernetDecrypt(token: Buffer | string, secretKey: string): string {
  const { signingKey, encryptionKey } = fernetKey(secretKey);
  const raw = Buffer.from(typeof token === "string" ? token : token.toString("utf8"), "base64url");

  if (raw.length < HEADER_LENGTH + HMAC_LENGTH || raw.readUInt8(0) !== VERSION) throw new FernetError("Malformed Fernet token");

  const body = raw.subarray(0, raw.length - HMAC_LENGTH);
  const mac = raw.subarray(raw.length - HMAC_LENGTH);
  const expected = createHmac("sha256", signingKey).update(body).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) throw new FernetError("Fernet signature mismatch");

  const iv = body.subarray(9, HEADER_LENGTH);
  const decipher = createDecipheriv("aes-128-cbc", encryptionKey, iv);
  return Buffer.concat([decipher.update(body.subarray(HEADER_LENGTH)), decipher.final()]).toString("utf8");
}

/**
 * Fernet tokens are url-safe base64 **with** padding (RFC 4648 §5), which
 * `Buffer.toString("base64url")` strips — an unpadded token is rejected by
 * every spec-compliant implementation, including the reference's.
 */
function base64Url(raw: Buffer): string {
  return raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}
