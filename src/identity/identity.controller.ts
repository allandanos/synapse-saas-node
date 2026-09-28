import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { SETTINGS, type Settings } from "../core/config";
import { AuthenticationError } from "../core/errors";
import { RequestContext } from "../core/request-context";
import { TenancyService } from "../tenancy/tenancy.service";
import {
  ForgotPasswordRequest,
  InviteAcceptRequest,
  LoginRequest,
  RefreshRequest,
  RegisterRequest,
  ResetPasswordRequest,
  SwitchOrgRequest,
} from "./identity.dto";
import { type AuthResponse, IdentityService, type RequestMeta, type TokenPair, type UserWithOrgs } from "./identity.service";
import { Public } from "./public.decorator";
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from "./refresh-cookie";

function requestMeta(req: Request): RequestMeta {
  return { userAgent: req.headers["user-agent"] ?? null, ip: req.ip ?? null };
}

function cookieToken(req: Request): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[REFRESH_COOKIE];
}

@Controller("v1/auth")
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly tenancy: TenancyService,
    private readonly context: RequestContext,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  @Public()
  @Post("register")
  @HttpCode(201)
  async register(@Body() body: RegisterRequest, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    const result = await this.identity.register({ email: body.email, password: body.password, displayName: body.display_name });
    setRefreshCookie(res, result.tokens.refresh_token, this.settings);
    return result;
  }

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Body() body: LoginRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    const result = await this.identity.login({ email: body.email, password: body.password }, requestMeta(req));
    setRefreshCookie(res, result.tokens.refresh_token, this.settings);
    return result;
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Body() body: RefreshRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<TokenPair> {
    const token = body.refresh_token || cookieToken(req);
    if (!token) throw new AuthenticationError("Missing refresh token");
    const pair = await this.identity.refresh(token, requestMeta(req));
    setRefreshCookie(res, pair.refresh_token, this.settings);
    return pair;
  }

  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = cookieToken(req);
    if (token) await this.identity.logout(token);
    clearRefreshCookie(res);
  }

  @Get("me")
  me(): Promise<UserWithOrgs> {
    return this.identity.me(this.context.requireUser().userId);
  }

  /** Mints a pair scoped to the org immediately (200 + body, like the reference server). */
  @Post("switch-org")
  @HttpCode(200)
  async switchOrg(
    @Body() body: SwitchOrgRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ access_token: string; token_type: string; expires_in: number }> {
    const pair = await this.identity.switchOrganization(this.context.requireUser().userId, body.organization_id, requestMeta(req));
    setRefreshCookie(res, pair.refresh_token, this.settings);
    return { access_token: pair.access_token, token_type: pair.token_type, expires_in: pair.expires_in };
  }

  /** Accept an organization invitation with its emailed token (single-use). */
  @Post("accept-invite")
  @HttpCode(200)
  acceptInvite(@Body() body: InviteAcceptRequest): Promise<{ organization_id: string; status: string }> {
    const user = this.context.requireUser();
    return this.tenancy.acceptInviteByToken(body.token, { userId: user.userId, email: user.email });
  }

  @Public()
  @Post("forgot-password")
  @HttpCode(202)
  async forgotPassword(@Body() body: ForgotPasswordRequest): Promise<{ ok: boolean }> {
    await this.identity.requestPasswordReset(body.email);
    return { ok: true };
  }

  @Public()
  @Post("reset-password")
  @HttpCode(200)
  async resetPassword(@Body() body: ResetPasswordRequest, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    const result = await this.identity.resetPassword(body.token, body.password);
    setRefreshCookie(res, result.tokens.refresh_token, this.settings);
    return result;
  }
}
