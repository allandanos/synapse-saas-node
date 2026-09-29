import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { Cron, Interval, SchedulerRegistry } from "@nestjs/schedule";
import { SETTINGS, type Settings } from "../core/config";
import { type JobName, JobsService } from "./jobs.service";

/**
 * The cadences, exactly as the reference's cron table: outbox every 5 s,
 * deliveries every 15 s, usage rollup hourly at :05, entitlement expiry at
 * :10, recurring billing at :20, partitions daily at 03:30, retention at
 * 03:40 (UTC).
 *
 * The timers run in-process with the API by default; `SYNAPSE_WORKER_ENABLED=false`
 * cancels them at boot (for a deployment that runs `pnpm worker` separately,
 * or a test that drives `JobsService` directly).
 */
@Injectable()
export class WorkerScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkerScheduler.name);

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly registry: SchedulerRegistry,
    private readonly jobs: JobsService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.settings.SYNAPSE_WORKER_ENABLED) {
      this.logger.log("background jobs enabled in-process (SYNAPSE_WORKER_ENABLED=false to run them elsewhere)");
      return;
    }
    for (const name of this.registry.getIntervals()) this.registry.deleteInterval(name);
    for (const [name] of this.registry.getCronJobs()) this.registry.deleteCronJob(name);
    this.logger.log("background jobs disabled (SYNAPSE_WORKER_ENABLED=false)");
  }

  @Interval("dispatch_outbox", 5_000)
  dispatchOutbox(): Promise<void> {
    return this.tick("dispatch_outbox");
  }

  @Interval("deliver_webhooks", 15_000)
  deliverWebhooks(): Promise<void> {
    return this.tick("deliver_webhooks");
  }

  @Cron("0 5 * * * *", { name: "rollup_usage" })
  rollupUsage(): Promise<void> {
    return this.tick("rollup_usage");
  }

  @Cron("0 10 * * * *", { name: "expire_entitlements" })
  expireEntitlements(): Promise<void> {
    return this.tick("expire_entitlements");
  }

  @Cron("0 20 * * * *", { name: "advance_recurring_billing" })
  advanceRecurringBilling(): Promise<void> {
    return this.tick("advance_recurring_billing");
  }

  @Cron("0 30 3 * * *", { name: "ensure_partitions" })
  ensurePartitions(): Promise<void> {
    return this.tick("ensure_partitions");
  }

  @Cron("0 40 3 * * *", { name: "purge_expired" })
  purgeExpired(): Promise<void> {
    return this.tick("purge_expired");
  }

  /** A job failure is logged and the tick ends: the next one retries from the same rows. */
  private async tick(name: JobName): Promise<void> {
    try {
      const count = await this.jobs.run(name);
      if (count > 0) this.logger.log(`${name}: ${String(count)}`);
    } catch (error) {
      this.logger.error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
