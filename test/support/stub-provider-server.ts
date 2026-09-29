import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubCall {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface StubRoute {
  status?: number;
  json: unknown;
}

/**
 * A local HTTP server the provider clients can be pointed at: `fetchImpl` is
 * injectable precisely so no test ever talks to Stripe. Routes are matched on
 * `"<METHOD> <path>"`; every call is recorded for assertions.
 */
export class StubProviderServer {
  private server?: Server;
  readonly calls: StubCall[] = [];

  constructor(private readonly routes: Record<string, StubRoute>) {}

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        resolve();
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const url = request.url ?? "/";
    this.calls.push({ method: request.method ?? "GET", url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
    const route = this.routes[`${request.method ?? "GET"} ${url.split("?")[0] as string}`];
    response.writeHead(route?.status ?? (route ? 200 : 404), { "Content-Type": "application/json" });
    response.end(JSON.stringify(route?.json ?? { error: { message: "no stub route" } }));
  }
}
