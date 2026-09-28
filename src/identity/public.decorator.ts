import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "synapse:public";

/** Routes that need no bearer credential (probes, register/login/refresh, password reset). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
