import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { PermissionsGuard } from "../authorization/permissions.guard";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { PageQuery, sliceInMemory, TOTAL_COUNT_HEADER } from "../core/pagination";
import { RequestContext } from "../core/request-context";
import { UuidPipe } from "../core/validation";
import { TenantGuard } from "../tenancy/tenant.guard";
import { ApiKeyCreate } from "./api-keys.dto";
import type { ApiKeyRead } from "./api-keys.repository";
import { ApiKeysService } from "./api-keys.service";

@Controller("v1/api-keys")
@UseGuards(TenantGuard, PermissionsGuard)
@RequirePermission("apikey:manage")
export class ApiKeysController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly context: RequestContext,
  ) {}

  /** Plain array body + `X-Total-Count`; the secret is never listed. */
  @Get()
  async list(@Query() page: PageQuery, @Res({ passthrough: true }) res: Response): Promise<ApiKeyRead[]> {
    const keys = await this.apiKeys.listKeys(this.context.requireTenant().organizationId);
    const { items, total } = sliceInMemory(keys, page);
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return items;
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: ApiKeyCreate): Promise<ApiKeyRead & { key: string }> {
    const tenant = this.context.requireTenant();
    // Bound by the CREATOR: the permission guard just bound the acting principal's
    // effective permissions (RBAC keys, "*" for platform admin, or the parent key's
    // scopes when a key mints a key — rooted at the human who created the parent).
    const principal = this.context.requireUser();
    const { key, plaintext } = await this.apiKeys.createKey({
      organizationId: tenant.organizationId,
      name: body.name,
      scopes: body.scopes ?? [],
      expiresInDays: body.expires_in_days ?? null,
      createdByUserId: principal.apiKeyId !== null ? principal.apiKeyCreatorId : principal.userId,
      creatorKeys: principal.permissionKeys,
    });
    return { ...key, key: plaintext };
  }

  @Delete(":keyId")
  @HttpCode(204)
  revoke(@Param("keyId", UuidPipe) keyId: string): Promise<void> {
    return this.apiKeys.revokeKey(keyId, this.context.requireTenant().organizationId);
  }
}
