import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEV_SECRET_KEY } from "../../src/core/config";
import { verifySignature } from "../../src/core/security";
import { buildEnvelope, DELIVERY_BACKOFF_SECONDS, deliveryBackoffSeconds, MAX_DELIVERY_ATTEMPTS } from "../../src/webhooks/envelope";
import { fernetDecrypt, fernetEncrypt, FernetError } from "../../src/webhooks/fernet";
import { signatureHeader } from "../../src/webhooks/signer";
import { toEndpointRead } from "../../src/webhooks/endpoints.repository";
import { normaliseHttpUrl } from "../../src/webhooks/webhooks.dto";
import { mintEndpointSecret } from "../../src/webhooks/webhooks.service";
import { OUTBOX_BACKOFF_SECONDS, OUTBOX_MAX_ATTEMPTS } from "../../src/worker/outbox.repository";
import { selectJobs } from "../../src/cli/jobs-run-once";
import { JOB_NAMES } from "../../src/worker/jobs.service";

/**
 * Produced by the reference's `cryptography.fernet` under the dev secret key.
 * If this stops decrypting, endpoints created by the Python server are no
 * longer deliverable by this one — a contract break, not a test detail.
 */
const REFERENCE_TOKEN = "gAAAAABquyYw0sD1XYbZkNJa-uS4xt6uZOdKdC74cBWnMHfR31IDW6UQdCTL6RmsP6IfDo7_4gfHtuRgkKXLLJkflgbrWKhcu5Ogke_y1pnqHNh1rviF1BQ=";

describe("fernet codec", () => {
  it("round-trips and stays url-safe base64 with padding", () => {
    const token = fernetEncrypt("whsec_local", DEV_SECRET_KEY);
    expect(token.toString("utf8")).toMatch(/^[A-Za-z0-9_-]+={0,2}$/);
    expect(fernetDecrypt(token, DEV_SECRET_KEY)).toBe("whsec_local");
  });

  it("decrypts a token minted by the Python reference", () => {
    expect(fernetDecrypt(REFERENCE_TOKEN, DEV_SECRET_KEY)).toBe("whsec_reference_fixture");
  });

  it("refuses a tampered token, the wrong key and a bad version byte", () => {
    const token = fernetEncrypt("whsec_local", DEV_SECRET_KEY).toString("utf8");
    const tampered = `${token.slice(0, -6)}AAAAA=`;
    expect(() => fernetDecrypt(tampered, DEV_SECRET_KEY)).toThrow(FernetError);
    expect(() => fernetDecrypt(token, "a-different-secret-key")).toThrow(FernetError);
    expect(() => fernetDecrypt(Buffer.from("AAAA", "utf8"), DEV_SECRET_KEY)).toThrow(/Malformed/);
  });
});

describe("outbound signature", () => {
  it("emits t=…,v1=hex over '<unix>.<body>' and verifies with the endpoint secret", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    const { name, value, timestamp } = signatureHeader(body, "whsec_x", 1_700_000_000);
    expect(name).toBe("X-Synapse-Signature");
    expect(value).toBe(`t=1700000000,v1=${createHmac("sha256", "whsec_x").update("1700000000.").update(body).digest("hex")}`);
    const signature = value.split("v1=")[1] as string;
    expect(verifySignature(body, "whsec_x", timestamp, signature)).toBe(true);
    expect(verifySignature(Buffer.concat([body, Buffer.from(" ")]), "whsec_x", timestamp, signature)).toBe(false);
    expect(verifySignature(body, "whsec_other", timestamp, signature)).toBe(false);
  });

  it("wraps the payload in the delivery envelope", () => {
    const envelope = buildEnvelope(
      { id: "d1", event_type: "invoice.paid", organization_id: "org-1", payload: { total_cents: 100 } },
      new Date("2026-09-29T10:00:00Z"),
    );
    expect(envelope).toEqual({
      id: "d1",
      event_type: "invoice.paid",
      organization_id: "org-1",
      created_at: "2026-09-29T10:00:00.000Z",
      data: { total_cents: 100 },
    });
  });
});

describe("retry ladders", () => {
  it("matches the reference's delivery ladder and clamps at the last rung", () => {
    expect(DELIVERY_BACKOFF_SECONDS).toEqual([60, 300, 1800, 7200, 21600]);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(6);
    expect([1, 2, 3, 4, 5, 6, 99].map(deliveryBackoffSeconds)).toEqual([60, 300, 1800, 7200, 21600, 21600, 21600]);
  });

  it("matches the reference's outbox ladder and dead-letter threshold", () => {
    expect(OUTBOX_BACKOFF_SECONDS).toEqual([5, 30, 120, 600, 1800, 3600, 3600, 3600]);
    expect(OUTBOX_MAX_ATTEMPTS).toBe(8);
    expect(OUTBOX_BACKOFF_SECONDS).toHaveLength(OUTBOX_MAX_ATTEMPTS);
  });
});

describe("jobs run-once selection", () => {
  it("takes --all, named jobs, and refuses anything else", () => {
    expect(selectJobs(["--all"]).jobs).toEqual([...JOB_NAMES]);
    expect(selectJobs(["rollup_usage", "purge_expired"]).jobs).toEqual(["rollup_usage", "purge_expired"]);
    expect(selectJobs([]).error).toMatch(/Name at least one job/);
    expect(selectJobs(["nope"]).error).toMatch(/Unknown job\(s\): nope/);
  });
});

describe("endpoint reads and secrets", () => {
  it("mints a whsec_ secret with the reference's entropy and alphabet", () => {
    const secret = mintEndpointSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/); // 24 bytes, url-safe base64
    expect(mintEndpointSecret()).not.toBe(secret);
  });

  it("never carries the secret into an endpoint read", () => {
    const row = {
      id: "e1",
      organization_id: "o1",
      url: "https://hooks.example.com/x",
      secret_encrypted: fernetEncrypt("whsec_top_secret", DEV_SECRET_KEY),
      description: "d",
      events: ["invoice.paid"],
      is_active: true,
      created_at: new Date("2026-09-29T10:00:00.000Z"),
    };
    const read = toEndpointRead(row);
    expect(Object.keys(read).sort()).toEqual(["created_at", "description", "events", "id", "is_active", "url"]);
    expect(JSON.stringify(read)).not.toContain("secret");
  });

  it("accepts the URLs pydantic's HttpUrl accepts and normalises them the same way", () => {
    expect(normaliseHttpUrl("https://hooks.example.com")).toBe("https://hooks.example.com/");
    expect(normaliseHttpUrl("https://Hooks.Example.com/Path")).toBe("https://hooks.example.com/Path");
    expect(normaliseHttpUrl("http://localhost:9000/hook")).toBe("http://localhost:9000/hook");
  });

  it("refuses what HttpUrl refuses — relative, scheme-less and non-http URLs", () => {
    for (const bad of ["not a url", "", "/hooks", "hooks.example.com", "ftp://host/x", "javascript:alert(1)"]) {
      expect(normaliseHttpUrl(bad), bad).toBeNull();
    }
  });
});
