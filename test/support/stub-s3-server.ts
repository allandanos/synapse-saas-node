import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An S3-shaped object store over plain HTTP, path-style
 * (`/{bucket}/{key…}`), enough for PUT / GET / HEAD / DELETE.
 *
 * MinIO's image is not pullable in this environment, so the S3 backend and
 * the presigned round trip are exercised against this instead. Signatures are
 * NOT verified — the point is the backend's request shape and the routes'
 * behaviour on an S3-capable backend, not re-testing the AWS SDK's SigV4.
 */
export class StubS3Server {
  private server?: Server;
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly calls: { method: string; path: string }[] = [];

  constructor(readonly bucket: string) {}

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
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

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    const method = request.method ?? "GET";
    this.calls.push({ method, path });
    const prefix = `/${this.bucket}/`;
    if (!path.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const key = path.slice(prefix.length);

    if (method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        this.objects.set(key, { body: Buffer.concat(chunks), contentType: request.headers["content-type"] ?? "application/octet-stream" });
        response.writeHead(200, { ETag: '"stub"' }).end();
      });
      return;
    }

    const stored = this.objects.get(key);
    if (method === "DELETE") {
      this.objects.delete(key);
      response.writeHead(204).end();
      return;
    }
    if (!stored) {
      response.writeHead(404, { "Content-Type": "application/xml" }).end(method === "HEAD" ? undefined : "<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    const headers = { "Content-Type": stored.contentType, "Content-Length": String(stored.body.length) };
    if (method === "HEAD") {
      response.writeHead(200, headers).end();
      return;
    }
    response.writeHead(200, headers).end(stored.body);
  }
}
