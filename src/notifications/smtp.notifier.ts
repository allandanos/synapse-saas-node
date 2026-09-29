import { Logger } from "@nestjs/common";
import { createTransport, type SendMailOptions, type Transporter } from "nodemailer";
import type { Settings } from "../core/config";
import { NoopNotifier } from "./noop.notifier";
import type { Message, Notifier } from "./notifier";

const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * The nodemailer message for an outbound notification. Attachments go out with
 * nodemailer's own MIME spelling — the contract is "a base64 application/pdf
 * part named after the invoice", not one mail library's byte layout (the
 * console's `pdfAttachmentBase64` fixture accepts any of them).
 */
export function toMailOptions(from: string, message: Message): SendMailOptions {
  return {
    from,
    to: message.to,
    subject: message.subject,
    text: message.body,
    attachments: (message.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType,
    })),
  };
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
      await this.transporter().sendMail(toMailOptions(this.settings.SYNAPSE_SMTP_FROM, message));
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
