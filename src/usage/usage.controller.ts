import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { InvalidRequestError, ValidationFailedError } from "../core/errors";
import { RequestContext } from "../core/request-context";
import { TenantGuard } from "../tenancy/tenant.guard";
import { GaugeIn, UsageBatchIn, UsageCheckQuery, UsageSummaryQuery } from "./usage.dto";
import { type UsageCheck, type UsageResult, UsageService, type UsageSummary } from "./usage.service";

/** Metering routes: tenant-scoped, no permission beyond membership (like the reference). */
@Controller("v1/usage")
@UseGuards(TenantGuard)
export class UsageController {
  constructor(
    private readonly context: RequestContext,
    private readonly usage: UsageService,
  ) {}

  /** Meter usage. Recording never blocks (soft path). */
  @Post("events")
  @HttpCode(201)
  record(@Body() body: UsageBatchIn): Promise<UsageResult[]> {
    return this.usage.recordEvents(this.context.requireTenant().organizationId, body.events);
  }

  /** Meter + enforce ONE event. 402 with upgrade hints on breach; more than one event is a 422. */
  @Post("consume")
  @HttpCode(200)
  consume(@Body() body: UsageBatchIn): Promise<UsageResult> {
    if (body.events.length !== 1) {
      throw new InvalidRequestError("consume takes exactly one event; use /usage/consume-batch for batches", {
        events: body.events.length,
        batch_url: "/v1/usage/consume-batch",
      });
    }
    return this.usage.consumeOne(this.context.requireTenant().organizationId, body.events[0] as UsageBatchIn["events"][number]);
  }

  /** Meter + enforce a batch atomically: the first breach 402s and NOTHING in the batch is counted. */
  @Post("consume-batch")
  @HttpCode(200)
  consumeBatch(@Body() body: UsageBatchIn): Promise<UsageResult[]> {
    return this.usage.consumeBatch(this.context.requireTenant().organizationId, body.events);
  }

  /** Set (`value`) or move (`delta`) a gauge metric; a positive `delta` is capacity-checked (402). */
  @Post("gauge")
  @HttpCode(200)
  gauge(@Body() body: GaugeIn): Promise<UsageResult> {
    if ((body.value == null) === (body.delta == null)) {
      throw new ValidationFailedError([{ loc: ["body"], msg: "provide exactly one of value or delta", type: "value_error" }]);
    }
    return this.usage.gauge(this.context.requireTenant().organizationId, body.metric, { value: body.value, delta: body.delta });
  }

  @Get("check")
  check(@Query() query: UsageCheckQuery): Promise<UsageCheck> {
    return this.usage.checkUsage(this.context.requireTenant().organizationId, query.metric, query.quantity ?? 1);
  }

  @Get("summary")
  summary(@Query() query: UsageSummaryQuery): Promise<UsageSummary> {
    const period = query.period ? `${query.period}-01` : undefined;
    return this.usage.usageSummary(this.context.requireTenant().organizationId, period);
  }
}
