/**
 * The transport seam for outbound email. SMTP or Noop, chosen by
 * `SYNAPSE_NOTIFIER` + `SYNAPSE_SMTP_HOST`; swap the transport by binding a
 * different implementation. The protocol carries attachments (invoice PDFs)
 * so any transport can honour them.
 */

export interface Attachment {
  readonly filename: string;
  readonly content: Buffer;
  readonly contentType: string;
}

export interface Message {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly attachments?: readonly Attachment[];
}

export interface Notifier {
  /** Best effort by contract: a delivery failure logs and returns, never throws. */
  send(message: Message): Promise<void>;
}

export const NOTIFIER = Symbol("NOTIFIER");
