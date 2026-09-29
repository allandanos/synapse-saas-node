import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";

export interface Keypair {
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
  kid: string;
}

/** An RSA keypair plus the public JWK Keycloak would publish for it. */
export function makeKeypair(kid = "test-key"): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }, kid };
}

/** `null` removes a default claim — that is how the "missing claim" cases are built. */
export interface TokenClaims {
  iss?: string;
  aud?: string;
  sub?: string | null;
  email?: string;
  email_verified?: boolean;
  name?: string;
  nonce?: string;
  exp?: number | null;
  iat?: number | null;
  [claim: string]: unknown;
}

/** Sign an id_token the way the realm would. `null` removes a default claim. */
export function idToken(keypair: Keypair, issuer: string, claims: TokenClaims = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: issuer,
    aud: "synapse-web",
    sub: "kc-sub-1",
    email: "sso@example.com",
    email_verified: true,
    name: "Sso User",
    iat: now,
    exp: now + 300,
    ...claims,
  };
  for (const [key, value] of Object.entries(payload)) if (value === null) delete payload[key];
  return jwt.sign(payload, keypair.privateKey.export({ type: "pkcs8", format: "pem" }), { algorithm: "RS256", header: { alg: "RS256", kid: keypair.kid } });
}

/**
 * A Keycloak-shaped IdP: `/realms/<realm>/protocol/openid-connect/{token,certs}`.
 * The token endpoint hands back whatever `nextToken` is set to, and every
 * request is recorded so the PKCE verifier can be asserted.
 */
export class StubIdp {
  private server?: Server;
  readonly tokenCalls: { body: string }[] = [];
  certsCalls = 0;
  nextToken: string | null = null;
  tokenStatus = 200;
  keys: Record<string, unknown>[] = [];
  origin = "";

  constructor(readonly realm = "synapse") {}

  get issuer(): string {
    return `${this.origin}/realms/${this.realm}`;
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${String(port)}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        resolve();
      });
    });
    this.server = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (path.endsWith("/protocol/openid-connect/certs")) {
      this.certsCalls += 1;
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: this.keys }));
      return;
    }
    if (path.endsWith("/protocol/openid-connect/token")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      this.tokenCalls.push({ body: Buffer.concat(chunks).toString("utf8") });
      response
        .writeHead(this.tokenStatus, { "Content-Type": "application/json" })
        .end(JSON.stringify(this.tokenStatus === 200 ? { id_token: this.nextToken } : { error: "invalid_grant" }));
      return;
    }
    response.writeHead(404).end();
  }
}
