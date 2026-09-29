import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AuthorizationModule } from "../authorization/authorization.module";
import { BillingModule } from "../billing/billing.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { FilesRepository } from "../storage/files.repository";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { UsageModule } from "../usage/usage.module";
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
  imports: [ScheduleModule.forRoot(), AuthorizationModule, BillingModule, SubscriptionsModule, EntitlementsModule, WebhooksModule, NotificationsModule, UsageModule],
  providers: [AdvisoryLock, OutboxRepository, FilesRepository, JobsService, WorkerScheduler],
  exports: [JobsService],
})
export class WorkerModule {}
