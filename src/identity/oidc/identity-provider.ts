import { Inject, Injectable } from "@nestjs/common";
import { SETTINGS, type Settings } from "../../core/config";
import { AuthenticationError } from "../../core/errors";
import { signingKeyFor, type VerifiedClaims, verifyIdToken } from "./jwks";

/** The scope the reference asks Keycloak for, verbatim. */
export const OIDC_SCOPE = "openid email profile";
/** A slow IdP must not hold a request open forever. */
export const OIDC_TIMEOUT_MS = 10_000;

export interface AuthorizationUrlInput {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

export interface ExchangeInput {
  redirectUri: string;
  codeVerifier?: string | null;
  nonce?: string | null;
}

/**
 * What the identity service needs of any auth backend. Local email/password
 * today, Keycloak OIDC when an org needs SSO — the service layer never knows
 * which is active (`identity/provider.py`).
 */
export interface IdentityProvider {
  readonly name: string;
  authorizationUrl(input: AuthorizationUrlInput): string;
  exchangeCode(code: string, input: ExchangeInput): Promise<VerifiedClaims>;
}

/**
 * Keycloak, the authorization-code flow with PKCE
 * (`/v1/auth/oidc/start` → Keycloak → `/v1/auth/oidc/callback`).
 */
@Injectable()
export class KeycloakProvider implements IdentityProvider {
  readonly name = "keycloak";

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private config(): { baseUrl: string; realm: string; clientId: string; clientSecret: string } {
    const baseUrl = this.settings.SYNAPSE_KEYCLOAK_BASE_URL.replace(/\/+$/, "");
    const realm = this.settings.SYNAPSE_KEYCLOAK_REALM;
    if (!baseUrl || !realm) throw new AuthenticationError("Keycloak is not configured");
    return { baseUrl, realm, clientId: this.settings.SYNAPSE_KEYCLOAK_CLIENT_ID, clientSecret: this.settings.SYNAPSE_KEYCLOAK_CLIENT_SECRET };
  }

  get issuer(): string {
    const { baseUrl, realm } = this.config();
    return `${baseUrl}/realms/${realm}`;
  }

  /** Where to send the browser to start an OIDC login. */
  authorizationUrl(input: AuthorizationUrlInput): string {
    const { clientId } = this.config();
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      scope: OIDC_SCOPE,
      redirect_uri: input.redirectUri,
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${this.issuer}/protocol/openid-connect/auth?${query.toString()}`;
  }

  /**
   * Authorization-code callback → the verified id_token claims.
   *
   * Verifies the RS256 signature against the realm JWKS (cached one hour,
   * refetched once on an unknown kid), `iss`, `aud`, expiry, and the `nonce`
   * bound to this login attempt.
   */
  async exchangeCode(code: string, input: ExchangeInput): Promise<VerifiedClaims> {
    const { clientId, clientSecret } = this.config();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: input.redirectUri,
    });
    if (input.codeVerifier) form.set("code_verifier", input.codeVerifier);
    const idToken = await this.token(form);
    const key = await signingKeyFor(idToken, this.issuer, this.fetchImpl);
    const claims = verifyIdToken(idToken, key, { issuer: this.issuer, audience: clientId });
    if (input.nonce != null && claims.nonce !== input.nonce) throw new AuthenticationError("OIDC nonce mismatch");
    return claims;
  }

  /**
   * Email + password proxied to Keycloak (the resource-owner password grant).
   * Off unless SYNAPSE_KEYCLOAK_ALLOW_PASSWORD_GRANT=true — the code flow is
   * the default, and a password grant hands the password to the API.
   */
  async verifyCredentials(email: string, password: string): Promise<VerifiedClaims | null> {
    if (!this.settings.SYNAPSE_KEYCLOAK_ALLOW_PASSWORD_GRANT) return null;
    const { clientId, clientSecret } = this.config();
    const form = new URLSearchParams({ grant_type: "password", client_id: clientId, client_secret: clientSecret, username: email, password, scope: "openid" });
    try {
      const idToken = await this.token(form);
      const key = await signingKeyFor(idToken, this.issuer, this.fetchImpl);
      return verifyIdToken(idToken, key, { issuer: this.issuer, audience: clientId });
    } catch {
      return null;
    }
  }

  private async token(form: URLSearchParams): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.issuer}/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AuthenticationError(`OIDC code exchange failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new AuthenticationError("OIDC code exchange failed");
    const body = (await response.json()) as { id_token?: string };
    if (!body.id_token) throw new AuthenticationError("OIDC token response carried no id_token");
    return body.id_token;
  }
}

/** Built-in email/password auth. The default — zero external dependencies. */
@Injectable()
export class LocalIdentityProvider implements IdentityProvider {
  readonly name = "local";

  authorizationUrl(): string {
    throw new AuthenticationError("SSO is not available with the local identity provider");
  }

  exchangeCode(): Promise<VerifiedClaims> {
    throw new AuthenticationError("OIDC is not available with the local identity provider");
  }
}

export const IDENTITY_PROVIDER = Symbol("IDENTITY_PROVIDER");

export function createIdentityProvider(settings: Settings): IdentityProvider {
  return settings.SYNAPSE_IDENTITY_PROVIDER === "keycloak" ? new KeycloakProvider(settings) : new LocalIdentityProvider();
}
