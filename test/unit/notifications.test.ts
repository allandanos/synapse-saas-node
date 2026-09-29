import { describe, expect, it } from "vitest";
import { rawAttachmentPart } from "../../src/notifications/smtp.notifier";

/**
 * The MIME the reference emits (Python `EmailMessage.add_attachment`) is part of
 * the observable surface: the console's `invoice-email.spec.ts` matches the
 * attachment part with this exact regex, so the port composes the part itself
 * rather than letting nodemailer pick its own spelling.
 */
const CONSOLE_ATTACHMENT_RE =
  /Content-Type: application\/pdf\nContent-Transfer-Encoding: base64\nContent-Disposition: attachment; filename="invoice-[^"]+\.pdf"\nMIME-Version: 1\.0\n\n([A-Za-z0-9+/=\n]+)/;

const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 0x41)]);

describe("smtp attachment part", () => {
  it("matches the part shape the console journey parses", () => {
    const part = rawAttachmentPart({ filename: "invoice-INV-202609-0001.pdf", content: pdf, contentType: "application/pdf" });

    const match = part.replace(/\r\n/g, "\n").match(CONSOLE_ATTACHMENT_RE);
    expect(match, part.slice(0, 200)).toBeTruthy();
    expect(Buffer.from((match?.[1] ?? "").replace(/\n/g, ""), "base64")).toEqual(pdf);
  });

  it("uses CRLF line endings and folds base64 at 76 characters", () => {
    const part = rawAttachmentPart({ filename: "invoice-INV-1.pdf", content: pdf, contentType: "application/pdf" });

    const body = part.split("\r\n\r\n")[1];
    const lines = body.split("\r\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
    expect(part).not.toMatch(/[^\r]\n/);
  });
});
