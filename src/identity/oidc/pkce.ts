import { createHash, randomBytes } from "node:crypto";

/** Bytes of entropy, matching the reference's `secrets.token_urlsafe(n)` calls. */
const STATE_BYTES = 32;
const VERIFIER_BYTES = 64;
const NONCE_BYTES = 16;

/** base64url without padding — what OAuth/OIDC expects everywhere. */
function urlSafe(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export interface LoginAttempt {
  /** The opaque handle the IdP echoes back; the server keeps everything else. */
  readonly state: string;
  /** PKCE: kept server-side, sent only at token exchange. */
  readonly verifier: string;
  /** PKCE: sent to the IdP up front. */
  readonly challenge: string;
  /** Bound into the id_token and checked on the way back (replay defence). */
  readonly nonce: string;
}

/** S256: the challenge is the SHA-256 of the verifier, base64url-encoded. */
export function codeChallenge(verifier: string): string {
  return urlSafe(createHash("sha256").update(verifier).digest());
}

export function newLoginAttempt(): LoginAttempt {
  const verifier = urlSafe(randomBytes(VERIFIER_BYTES));
  return {
    state: urlSafe(randomBytes(STATE_BYTES)),
    verifier,
    challenge: codeChallenge(verifier),
    nonce: urlSafe(randomBytes(NONCE_BYTES)),
  };
}

/** Only same-origin paths — never an open redirect (`_safe_return_to`). */
export function safeReturnTo(raw: string | null | undefined): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
}
