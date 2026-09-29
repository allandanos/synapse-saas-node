import type { Request } from "express";
import { ipInCidr } from "../../core/ip";

export function isTrustedProxy(host: string, cidrs: readonly string[]): boolean {
  return cidrs.some((cidr) => ipInCidr(host, cidr));
}

/**
 * The client address for rate limiting — never spoofable by the client.
 *
 * `X-Forwarded-For` is honoured only when the socket peer is a configured
 * trusted proxy, and then only back to the first hop that is NOT a trusted
 * proxy (walking right to left — each proxy appends the peer it saw). With no
 * trusted proxies configured the header is ignored outright, so an attacker
 * rotating the header is still bucketed by their real address.
 */
export function clientIp(request: Pick<Request, "socket" | "headers">, trustedProxies: readonly string[]): string {
  const peer = request.socket.remoteAddress ?? "unknown";
  if (trustedProxies.length === 0 || !isTrustedProxy(peer, trustedProxies)) return peer;
  const raw = request.headers["x-forwarded-for"];
  const header = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  const hops = header
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i] as string;
    if (!isTrustedProxy(hop, trustedProxies)) return hop;
  }
  return peer;
}
