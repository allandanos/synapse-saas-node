import { Controller, Get, Inject, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { CACHE_NAMESPACES, CacheRegistry } from "../../core/cache/cache.registry";
import type { VersionedCache } from "../../core/cache/versioned-cache";
import { SETTINGS, type Settings } from "../../core/config";
import { Database } from "../../core/db/database";
import { AuthenticationError } from "../../core/errors";
import { IdentityService } from "../identity.service";
import { Public } from "../public.decorator";
import { setRefreshCookie } from "../refresh-cookie";
import { IDENTITY_PROVIDER, type IdentityProvider } from "./identity-provider";
import { newLoginAttempt, safeReturnTo } from "./pkce";

/** The callback route, as Keycloak must see it when no explicit URI is configured. */
export const CALLBACK_PATH = "/v1/auth/oidc/callback";

interface PendingLogin {
  verifier: string;
  nonce: string;
  return_to: string;
}

/**
 * OIDC login — the authorization-code flow with PKCE (ADR 0010).
 *
 * The browser never sees a token in a URL: the callback sets the httpOnly
 * refresh cookie and bounces to the console, which mints an access token
 * through `/v1/auth/refresh`.
 */
@Public()
@Controller("v1/auth/oidc")
export class OidcController {
  /** state → {verifier, nonce, return_to}, 600 s and single use. */
  private readonly pending: VersionedCache;

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    private readonly identity: IdentityService,
    private readonly db: Database,
    caches: CacheRegistry,
  ) {
    this.pending = caches.namespace(CACHE_NAMESPACES.OIDC);
  }

  /**
   * Start an SSO login: the PKCE verifier and the nonce stay server-side under
   * an opaque `state`; the browser is sent to the IdP.
   */
  @Get("start")
  async start(@Req() req: Request, @Res() res: Response, @Query("return_to") returnTo?: string): Promise<void> {
    const attempt = newLoginAttempt();
    const body: PendingLogin = { verifier: attempt.verifier, nonce: attempt.nonce, return_to: safeReturnTo(returnTo) };
    await this.pending.set(attempt.state, JSON.stringify(body));
    const url = this.provider.authorizationUrl({
      redirectUri: this.callbackUri(req),
      state: attempt.state,
      nonce: attempt.nonce,
      codeChallenge: attempt.challenge,
    });
    res.redirect(302, url);
  }

  /**
   * Finish an SSO login: consume the state (one shot), exchange the code with
   * PKCE, verify the id_token, link or create the user, set the refresh cookie.
   */
  @Get("callback")
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query("code") code?: string,
    @Query("state") state?: string,
    @Query("error") error?: string,
  ): Promise<void> {
    if (error) throw new AuthenticationError(`Identity provider refused the login: ${error}`);
    if (!code || !state) throw new AuthenticationError("Missing code or state");
    const raw = await this.pending.get(state);
    if (raw === null) throw new AuthenticationError("Unknown or expired login state");
    await this.pending.delete(state); // single use
    const attempt = JSON.parse(raw) as PendingLogin;

    const claims = await this.provider.exchangeCode(code, {
      redirectUri: this.callbackUri(req),
      codeVerifier: attempt.verifier,
      nonce: attempt.nonce,
    });
    const refreshToken = await this.db.transaction(async (tx) => {
      const user = await this.identity.linkOrCreateOidcUser(tx, claims, this.provider.name);
      const { pair } = await this.identity.issueTokens(tx, user, { userAgent: req.headers["user-agent"] ?? null, ip: req.ip ?? null });
      return pair.refresh_token;
    });
    setRefreshCookie(res, refreshToken, this.settings);
    const origin = this.settings.SYNAPSE_WEB_ORIGIN.replace(/\/+$/, "");
    res.redirect(302, `${origin}/auth/callback?return_to=${encodeURI(attempt.return_to)}`);
  }

  /** SYNAPSE_OIDC_REDIRECT_URI when set (proxies rewrite scheme/host), else this route's absolute URL. */
  private callbackUri(req: Request): string {
    if (this.settings.SYNAPSE_OIDC_REDIRECT_URI) return this.settings.SYNAPSE_OIDC_REDIRECT_URI;
    return `${req.protocol}://${req.get("host") ?? "localhost"}${CALLBACK_PATH}`;
  }
}
