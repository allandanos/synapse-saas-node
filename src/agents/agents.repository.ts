import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";

export interface AgentRow {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  description: string | null;
  status: "active" | "disabled";
  config: Record<string, unknown>;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** The wire shape (`AgentRead`): the tenant is implicit, `deleted_at` is not a tenant concern. */
export interface AgentRead {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export function toAgentRead(row: AgentRow): AgentRead {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    config: row.config,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const COLUMNS = "id, organization_id, slug, name, description, status, config, deleted_at, created_at, updated_at";

@Injectable()
export class AgentsRepository {
  /** Live rows for an org, oldest first (the reference orders by `created_at`). */
  listForOrg(tx: Tx, organizationId: string): Promise<AgentRow[]> {
    return tx.rows<AgentRow>(`SELECT ${COLUMNS} FROM agents WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [organizationId]);
  }

  findScoped(tx: Tx, id: string, organizationId: string): Promise<AgentRow | undefined> {
    return tx.one<AgentRow>(`SELECT ${COLUMNS} FROM agents WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`, [id, organizationId]);
  }

  /** Slug lookup INCLUDING soft-deleted rows: a retired slug is never reusable. */
  findBySlug(tx: Tx, organizationId: string, slug: string): Promise<AgentRow | undefined> {
    return tx.one<AgentRow>(`SELECT ${COLUMNS} FROM agents WHERE organization_id = $1 AND slug = $2`, [organizationId, slug]);
  }

  async insert(
    tx: Tx,
    agent: { organizationId: string; slug: string; name: string; description: string | null; config: Record<string, unknown> },
  ): Promise<AgentRow> {
    const row = await tx.one<AgentRow>(
      `INSERT INTO agents (id, organization_id, slug, name, description, status, config)
       VALUES ($1, $2, $3, $4, $5, 'active', $6::jsonb) RETURNING ${COLUMNS}`,
      [newUuid(), agent.organizationId, agent.slug, agent.name, agent.description, JSON.stringify(agent.config)],
    );
    return row as AgentRow;
  }

  async update(
    tx: Tx,
    id: string,
    patch: { name?: string; description?: string | null; config?: Record<string, unknown> },
  ): Promise<AgentRow> {
    const row = await tx.one<AgentRow>(
      `UPDATE agents
          SET name = COALESCE($2, name),
              description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              config = COALESCE($5::jsonb, config),
              updated_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, patch.name ?? null, patch.description !== undefined, patch.description ?? null, patch.config === undefined ? null : JSON.stringify(patch.config)],
    );
    return row as AgentRow;
  }

  async setStatus(tx: Tx, id: string, status: "active" | "disabled"): Promise<AgentRow> {
    const row = await tx.one<AgentRow>(`UPDATE agents SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [id, status]);
    return row as AgentRow;
  }

  /** Soft delete: registry rows are billing history, never hard-removed. */
  async softDelete(tx: Tx, id: string): Promise<void> {
    await tx.query(`UPDATE agents SET deleted_at = now(), status = 'disabled', updated_at = now() WHERE id = $1`, [id]);
  }
}
