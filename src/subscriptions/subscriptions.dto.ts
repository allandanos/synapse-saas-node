import { IsBoolean, IsOptional, IsString, MinLength } from "class-validator";

export class TrialStartRequest {
  @IsString()
  @MinLength(1)
  plan_key!: string;
}

export class PlanChangeRequest {
  @IsString()
  @MinLength(1)
  plan_key!: string;
}

export class CancelRequest {
  @IsOptional()
  @IsBoolean()
  at_period_end?: boolean = true;
}
