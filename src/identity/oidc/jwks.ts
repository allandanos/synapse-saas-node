import { createPublicKey, type KeyObject } from "node:crypto";
import jwt, { type JwtHeader, type JwtPayload } from "jsonwebtoken";
import { AuthenticationError } from "../../core/errors";

export const JWKS_TTL_SECONDS = 3600;

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  [claim: string]: unknown;
}

interface CacheEntry {
  fetchedAt: number;
  keys: Jwk[];
}

/**
 * The realm's signing keys, cached per issuer for an hour and refetched ONCE
 * on a `kid` we have not seen — which is exactly what a key rotation looks
 * like from here (`identity/provider.py::_signing_key`).
 *
 * Process-wide by design: a rotation should cost one fetch, not one per
 * request. `clearJwksCache()` is the test hook.
 */
const cache = new Map<string, CacheEntry>();

export function clearJwksCache(): void {
  cache.clear();
}

async function fetchJwks(issuer: string, fetchImpl: typeof fetch): Promise<Jwk[]> {
  const response = await fetchImpl(`${issuer}/protocol/openid-connect/certs`);
  if (!response.ok) throw new AuthenticationError(`Could not read the identity provider's signing keys (${String(response.status)})`);
  const body = (await response.json()) as { keys?: Jwk[] };
  return body.keys ?? [];
}

async function jwksFor(issuer: string, fetchImpl: typeof fetch, force: boolean): Promise<Jwk[]> {
  const entry = cache.get(issuer);
  if (entry && !force && (Date.now() - entry.fetchedAt) / 1000 < JWKS_TTL_SECONDS) return entry.keys;
  const keys = await fetchJwks(issuer, fetchImpl);
  cache.set(issuer, { fetchedAt: Date.now(), keys });
  return keys;
}

/** The JWK whose `kid` signed this token, fetching once more if it is unknown. */
export async function signingKeyFor(idToken: string, issuer: string, fetchImpl: typeof fetch): Promise<KeyObject> {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded) throw new AuthenticationError("OIDC id_token is not a JWT");
  const kid = (decoded.header as JwtHeader).kid;
  for (const force of [false, true]) {
    const match = (await jwksFor(issuer, fetchImpl, force)).find((jwk) => jwk.kid === kid);
    if (match) return createPublicKey({ key: match as never, format: "jwk" });
  }
  throw new AuthenticationError("No matching Keycloak signing key for token");
}

export interface VerifiedClaims extends JwtPayload {
  sub: string;
}

/**
 * RS256 signature, `iss`, `aud`, `exp`, and the presence of `iat`/`sub` —
 * the reference's `options={"require": ["exp", "iat", "sub"]}`. The bound
 * `nonce` is checked by the caller, which is the only party that knows it.
 */
export function verifyIdToken(idToken: string, key: KeyObject, options: { issuer: string; audience: string }): VerifiedClaims {
  let claims: JwtPayload;
  try {
    claims = jwt.verify(idToken, key, {
      algorithms: ["RS256"],
      issuer: options.issuer,
      audience: options.audience,
    }) as JwtPayload;
  } catch (error) {
    throw new AuthenticationError(`OIDC id_token rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const required of ["exp", "iat", "sub"] as const) {
    if (claims[required] === undefined) throw new AuthenticationError(`OIDC id_token rejected: missing '${required}'`);
  }
  return claims as VerifiedClaims;
}
