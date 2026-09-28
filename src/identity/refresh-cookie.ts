import type { Response } from "express";
import type { Settings } from "../core/config";

export const REFRESH_COOKIE = "synapse_rt";

/** httpOnly refresh cookie — the console's session; the body carries the same token for API clients. */
export function setRefreshCookie(res: Response, refreshToken: string, settings: Settings): void {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: settings.cookieSecure,
    maxAge: settings.refreshTokenTtlSeconds * 1000,
    path: "/",
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: "/" });
}
