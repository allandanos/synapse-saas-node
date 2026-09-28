import { IsEmail, IsOptional, IsString, IsUUID, Length, MinLength } from "class-validator";

export const PASSWORD_MIN_LENGTH = 10;

export class RegisterRequest {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  password!: string;

  @IsString()
  @Length(1, 200)
  display_name!: string;
}

export class LoginRequest {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

export class RefreshRequest {
  /** Also accepted via the httpOnly cookie. */
  @IsOptional()
  @IsString()
  refresh_token?: string | null;
}

export class InviteAcceptRequest {
  @IsString()
  @MinLength(10)
  token!: string;
}

export class SwitchOrgRequest {
  @IsUUID()
  organization_id!: string;
}

export class ForgotPasswordRequest {
  @IsEmail()
  email!: string;
}

export class ResetPasswordRequest {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  password!: string;
}
