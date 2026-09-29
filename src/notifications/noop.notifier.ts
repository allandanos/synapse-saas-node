import { Logger } from "@nestjs/common";
import type { Message, Notifier } from "./notifier";

/** The log-only transport: what runs when no SMTP host is configured. */
export class NoopNotifier implements Notifier {
  private readonly logger = new Logger(NoopNotifier.name);

  send(message: Message): Promise<void> {
    this.logger.log(`notification suppressed to=${message.to} subject=${JSON.stringify(message.subject)} attachments=${String(message.attachments?.length ?? 0)}`);
    return Promise.resolve();
  }
}
