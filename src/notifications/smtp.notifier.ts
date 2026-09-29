import { Logger } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";
import type { Settings } from "../core/config";
import { NoopNotifier } from "./noop.notifier";
import type { Message, Notifier } from "./notifier";

const CONNECTION_TIMEOUT_MS = 10_000;

/** RFC 2045 base64 line length. */
const BASE64_LINE_LENGTH = 76;

/**
 * The attachment part, byte-for-byte as the reference emits it (Python's
 * `EmailMessage.add_attachment`): a bare `Content-Type`, base64, a *quoted*
 * filename, then `MIME-Version` — in that order. Recipients parse any valid
 * spelling, but the console's e2e journey matches this exact part, so nodemailer
 * gets the source verbatim instead of composing its own (`name=` parameter,
 * unquoted filename, no per-part MIME-Version).
 */
export function rawAttachmentPart(attachment: { filename: string; content: Buffer; contentType: string }): string {
  const body = attachment.content
    .toString("base64")
    .replace(new RegExp(`(.{${String(BASE64_LINE_LENGTH)}})`, "g"), "$1\r\n");
  return (
    `Content-Type: ${attachment.contentType}\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-Disposition: attachment; filename="${attachment.filename}"\r\n` +
    `MIME-Version: 1.0\r\n\r\n${body}\r\n`
  );
}

/**
 * SMTP delivery through the configured relay, failing soft: an email problem
 * must never fail the outbox dispatch that carries it.
 *
 * Transport security follows `SYNAPSE_SMTP_TLS`: `ssl` is implicit TLS from
 * the first byte (port 465), `starttls` upgrades after the greeting (587),
 * `none` is plaintext (MailHog, or a trusted relay on localhost). Credentials
 * are sent only once the channel is secured — never in the clear.
 */
export class SmtpNotifier implements Notifier {
  private readonly logger = new Logger(SmtpNotifier.name);
  private transport?: Transporter;

  constructor(private readonly settings: Settings) {}

  async send(message: Message): Promise<void> {
    try {
      if (this.settings.SYNAPSE_SMTP_USERNAME && this.settings.SYNAPSE_SMTP_TLS === "none") {
        throw new Error("SMTP AUTH over a plaintext connection is refused; set SYNAPSE_SMTP_TLS");
      }
      await this.transporter().sendMail({
        from: this.settings.SYNAPSE_SMTP_FROM,
        to: message.to,
        subject: message.subject,
        text: message.body,
        attachments: (message.attachments ?? []).map((attachment) => ({ raw: rawAttachmentPart(attachment) })),
      });
      this.logger.log(`email sent to=${message.to} subject=${JSON.stringify(message.subject)} attachments=${String(message.attachments?.length ?? 0)}`);
    } catch (error) {
      this.logger.warn(`email send failed to=${message.to} subject=${JSON.stringify(message.subject)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private transporter(): Transporter {
    this.transport ??= createTransport({
      host: this.settings.SYNAPSE_SMTP_HOST,
      port: this.settings.SYNAPSE_SMTP_PORT,
      secure: this.settings.SYNAPSE_SMTP_TLS === "ssl",
      requireTLS: this.settings.SYNAPSE_SMTP_TLS === "starttls",
      ignoreTLS: this.settings.SYNAPSE_SMTP_TLS === "none",
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: CONNECTION_TIMEOUT_MS,
      ...(this.settings.SYNAPSE_SMTP_USERNAME
        ? { auth: { user: this.settings.SYNAPSE_SMTP_USERNAME, pass: this.settings.SYNAPSE_SMTP_PASSWORD } }
        : {}),
    });
    return this.transport;
  }
}

/** The configured transport: SMTP once a host is set and `SYNAPSE_NOTIFIER` allows it, else Noop. */
export function buildNotifier(settings: Settings): Notifier {
  if (settings.SYNAPSE_NOTIFIER === "noop" || !settings.SYNAPSE_SMTP_HOST) return new NoopNotifier();
  return new SmtpNotifier(settings);
}
