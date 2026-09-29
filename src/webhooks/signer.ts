import { signPayload } from "../core/security";
import { SIGNATURE_HEADER } from "./envelope";

/**
 * `X-Synapse-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 over
 * "<unix>.<body>" with the endpoint secret>` — the same scheme the framework
 * verifies on the way in, so a tenant can reuse one helper in both directions.
 */
export function signatureHeader(body: Buffer, secret: string, timestamp = Math.floor(Date.now() / 1000)): { name: string; value: string; timestamp: number } {
  return { name: SIGNATURE_HEADER, value: `t=${String(timestamp)},v1=${signPayload(body, secret, timestamp)}`, timestamp };
}
