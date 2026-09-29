import { createTransport } from "nodemailer";
import { describe, expect, it } from "vitest";
import { toMailOptions } from "../../src/notifications/smtp.notifier";

/**
 * What the console asserts about invoice mail is that a PDF is attached, not
 * how the MIME is spelled: `apps/web/e2e/fixtures.ts:pdfAttachmentBase64`
 * accepts Python's, nodemailer's and JavaMail's layouts alike. This suite
 * composes a real message through nodemailer and runs that same extraction
 * over the bytes, so an upgrade that changed the spelling still has to keep
 * the contract.
 */
const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 0x41)]);

/** Verbatim from the console's fixtures — the port must satisfy it as written. */
function pdfAttachmentBase64(raw: string): string | null {
  const flat = raw.replace(/\r\n/g, "\n");
  for (const part of flat.split(/\n--[^\n]+\n/)) {
    const sep = part.indexOf("\n\n");
    if (sep === -1) continue;
    const headers = part.slice(0, sep).replace(/\n[ \t]+/g, " "); // unfold
    if (!/content-type:\s*application\/pdf/i.test(headers)) continue;
    if (!/content-transfer-encoding:\s*base64/i.test(headers)) continue;
    const body = part.slice(sep + 2).split(/\n--/)[0]; // stop at the next boundary
    return body.replace(/\s+/g, "");
  }
  return null;
}

/** The composed MIME source, without touching the network. */
async function compose(message: Parameters<typeof toMailOptions>[1]): Promise<string> {
  const transport = createTransport({ streamTransport: true, buffer: true });
  const info = (await transport.sendMail(toMailOptions("billing@synapse.test", message))) as { message: Buffer };
  return info.message.toString("utf8");
}

describe("smtp message composition", () => {
  it("attaches the invoice PDF as a base64 application/pdf part the console can find", async () => {
    const raw = await compose({
      to: "ap@example.com",
      subject: "Invoice INV-202609-0001: 1,999.00 PHP due",
      body: "Invoice INV-202609-0001 is attached.",
      attachments: [{ filename: "invoice-INV-202609-0001.pdf", content: pdf, contentType: "application/pdf" }],
    });

    expect(raw).toContain("invoice-INV-202609-0001.pdf");
    const b64 = pdfAttachmentBase64(raw);
    expect(b64, "base64 application/pdf part present").toBeTruthy();
    expect(Buffer.from(b64 ?? "", "base64")).toEqual(pdf);
  });

  it("keeps the reset link extractable through quoted-printable folding", async () => {
    // The console's `resetTokenFromEmail` decodes soft breaks and `=3D` before
    // matching, so a long link folded mid-token must still round-trip.
    const token = "a".repeat(43);
    const link = `http://localhost:3400/reset-password?reset=${token}`;
    const raw = await compose({
      to: "user@example.com",
      subject: "Reset your password",
      body: `A password reset was requested for your account.\n\nReset it here (valid 30 minutes):\n${link}\n`,
    });

    const decoded = raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    expect(decoded.match(/\/reset-password\?reset=([A-Za-z0-9_-]+)/)?.[1]).toBe(token);
  });

  it("sends a message with no attachments as a plain body", async () => {
    const raw = await compose({ to: "user@example.com", subject: "Reset your password", body: "no attachment here" });

    expect(pdfAttachmentBase64(raw)).toBeNull();
    expect(raw).toContain("Subject: Reset your password");
  });
});
