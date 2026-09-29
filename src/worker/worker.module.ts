import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { BillingModule } from "../billing/billing.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { AdvisoryLock } from "./advisory-lock";
import { JobsService } from "./jobs.service";
import { OutboxRepository } from "./outbox.repository";
import { WorkerScheduler } from "./worker.scheduler";

/**
 * The worker: the engines it drives (billing, entitlements, webhooks,
 * notifications) plus the cadence. Runs in-process with the API by default and
 * standalone via `pnpm worker`; `pnpm jobs:run-once` executes the same methods
 * once each.
 */
@Module({
  imports: [ScheduleModule.forRoot(), BillingModule, SubscriptionsModule, EntitlementsModule, WebhooksModule, NotificationsModule],
  providers: [AdvisoryLock, OutboxRepository, JobsService, WorkerScheduler],
  exports: [JobsService],
})
export class WorkerModule {}
