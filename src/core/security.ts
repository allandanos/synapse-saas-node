import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { Algorithm, hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import jwt from "jsonwebtoken";
import { SETTINGS, type Settings } from "./config";
import { AuthenticationError } from "./errors";

/**
 * Password hashing and token helpers — same primitives and claims as the
 * reference, so hashes and JWTs are interchangeable given one SYNAPSE_SECRET_KEY:
 * argon2id (t=3, m=64MiB, p=4), HS256 access tokens with `sub`/`org`/`exp`,
 * opaque refresh tokens stored as SHA-256.
 */

export const JWT_ALGORITHM = "HS256";
export const JWT_ISSUER = "synapse-saas";
export const REFRESH_TOKEN_BYTES = 32;

const ARGON2_OPTIONS = { algorithm: Algorithm.Argon2id, timeCost: 3, memoryCost: 65_536, parallelism: 4, outputLen: 32 } as const;

/** Argon2 hash of an unguessable value — burns comparable CPU on unknown-email logins. */
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$c3NybU5vdEFSZWFsUGFzc3dvcmQ$bQ9OBGPOtW4Kpl6Z73pQ4Lc2v1OiqeuCYiY0FbxBNCs";

export interface AccessTokenInput {
  userId: string;
  email: string;
  organizationId?: string | null;
  isPlatformAdmin?: boolean;
  ttlSeconds?: number;
}

export interface AccessClaims {
  sub: string;
  email?: string;
  org?: string;
  platform_admin?: boolean;
  iat: number;
  exp: number;
  iss: string;
  type: "access";
}

export function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await argon2Verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Stripe-style v1 signature: `HMAC_SHA256(secret, "{timestamp}." + payload)`
 * as lowercase hex. Used for outbound webhook signatures (`X-Synapse-Signature`)
 * and to verify Stripe's and PayMongo's inbound ones.
 */
export function signPayload(payload: Buffer, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${String(timestamp)}.`).update(payload).digest("hex");
}

export function verifySignature(payload: Buffer, secret: string, timestamp: number, signature: string): boolean {
  return constantTimeEquals(signPayload(payload, secret, timestamp), signature);
}

/** Paddle signs `"{ts}:" + body` — a colon, not Stripe's dot. */
export function signPayloadColon(payload: Buffer, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${String(timestamp)}:`).update(payload).digest("hex");
}

@Injectable()
export class SecurityService {
  constructor(@Inject(SETTINGS) private readonly settings: Settings) {}

  hashPassword(password: string): Promise<string> {
    return hashPassword(password);
  }

  verifyPassword(password: string, passwordHash: string): Promise<boolean> {
    return verifyPassword(password, passwordHash);
  }

  createAccessToken(input: AccessTokenInput): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      sub: input.userId,
      email: input.email,
      iat: now,
      exp: now + (input.ttlSeconds ?? this.settings.accessTokenTtlSeconds),
      iss: JWT_ISSUER,
      type: "access",
    };
    if (input.organizationId) payload.org = input.organizationId;
    if (input.isPlatformAdmin) payload.platform_admin = true;
    return jwt.sign(payload, this.settings.SYNAPSE_SECRET_KEY, { algorithm: JWT_ALGORITHM });
  }

  /** Decode + validate. Throws AuthenticationError on any failure (never leaks which check failed). */
  decodeAccessToken(token: string): AccessClaims {
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, this.settings.SYNAPSE_SECRET_KEY, { algorithms: [JWT_ALGORITHM], issuer: JWT_ISSUER });
    } catch {
      throw new AuthenticationError("Access token is invalid or expired");
    }
    const claims = decoded as Partial<AccessClaims>;
    if (
      typeof claims !== "object" ||
      claims === null ||
      typeof claims.sub !== "string" ||
      typeof claims.exp !== "number" ||
      typeof claims.iat !== "number" ||
      claims.type !== "access"
    ) {
      throw new AuthenticationError("Access token is invalid or expired");
    }
    return claims as AccessClaims;
  }

  generateRefreshToken(): string {
    return generateRefreshToken();
  }

  hashToken(token: string): string {
    return sha256Hex(token);
  }
}
