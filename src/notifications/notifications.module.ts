import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { SETTINGS, type Settings } from "../core/config";
import { TenancyModule } from "../tenancy/tenancy.module";
import { NotificationHandlers } from "./handlers";
import { NOTIFIER } from "./notifier";
import { buildNotifier } from "./smtp.notifier";

/**
 * Email: the transport seam and the outbox-event handlers the worker drives.
 * Nothing in the request path imports this — mail is a post-commit consumer.
 */
@Module({
  imports: [BillingModule, TenancyModule],
  providers: [{ provide: NOTIFIER, inject: [SETTINGS], useFactory: (settings: Settings) => buildNotifier(settings) }, NotificationHandlers],
  exports: [NOTIFIER, NotificationHandlers],
})
export class NotificationsModule {}
