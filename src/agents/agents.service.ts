import { Injectable } from "@nestjs/common";
import { AuditWriter } from "../core/audit";
import { Database, type Tx } from "../core/db/database";
import { ConflictError, NotFoundError } from "../core/errors";
import { events } from "../core/events";
import { OutboxWriter } from "../core/outbox";
import { type AgentRead, type AgentRow, AgentsRepository, toAgentRead } from "./agents.repository";

export interface AgentCreateInput {
  slug: string;
  name: string;
  description?: string | null;
  config?: Record<string, unknown>;
}

export interface AgentUpdateInput {
  name?: string;
  description?: string | null;
  config?: Record<string, unknown>;
}

/**
 * Agent registry (ADR 0007): governance and billing only — this framework
 * registers agents, gates them behind entitlements and meters them; it never
 * executes them. `config` is opaque JSON owned by whichever runtime does.
 *
 * Every mutation emits its lifecycle event and its audit row INSIDE the
 * transaction (the worker fans the event out to webhooks after commit), and
 * every read is tenant-filtered by construction — a foreign id is a 404.
 */
@Injectable()
export class AgentsService {
  constructor(
    private readonly db: Database,
    private readonly agents: AgentsRepository,
    private readonly outbox: OutboxWriter,
    private readonly audit: AuditWriter,
  ) {}

  async list(organizationId: string): Promise<AgentRead[]> {
    const rows = await this.db.transaction((tx) => this.agents.listForOrg(tx, organizationId));
    return rows.map(toAgentRead);
  }

  async get(organizationId: string, agentId: string): Promise<AgentRead> {
    return toAgentRead(await this.db.transaction((tx) => this.requireScoped(tx, agentId, organizationId)));
  }

  create(organizationId: string, input: AgentCreateInput): Promise<AgentRead> {
    return this.db.transaction(async (tx) => {
      // Soft-deleted rows still hold their slug: the unique index covers them,
      // so reuse is a 409 rather than a constraint violation at INSERT time.
      if (await this.agents.findBySlug(tx, organizationId, input.slug)) {
        throw new ConflictError(`An agent with slug '${input.slug}' already exists in this organization`, { slug: input.slug });
      }
      const row = await this.agents.insert(tx, {
        organizationId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        config: input.config ?? {},
      });
      await this.outbox.append(tx, {
        eventType: events.AGENT_REGISTERED,
        aggregateType: "agent",
        aggregateId: row.id,
        organizationId,
        payload: { slug: row.slug, name: row.name },
      });
      await this.audit.log(tx, {
        eventType: "agent.registered",
        organizationId,
        targetType: "agent",
        targetId: row.id,
        diff: { slug: row.slug, name: row.name },
      });
      return toAgentRead(row);
    });
  }

  update(organizationId: string, agentId: string, input: AgentUpdateInput): Promise<AgentRead> {
    return this.db.transaction(async (tx) => {
      const current = await this.requireScoped(tx, agentId, organizationId);
      const diff: Record<string, unknown> = {};
      if (input.name !== undefined && input.name !== current.name) diff.name = { from: current.name, to: input.name };
      if (input.description !== undefined && input.description !== null && input.description !== current.description) {
        diff.description = { from: current.description, to: input.description };
      }
      if (input.config !== undefined && JSON.stringify(input.config) !== JSON.stringify(current.config)) diff.config = "updated";
      if (Object.keys(diff).length === 0) return toAgentRead(current);

      const row = await this.agents.update(tx, agentId, {
        name: diff.name ? input.name : undefined,
        description: diff.description ? (input.description as string) : undefined,
        config: diff.config ? input.config : undefined,
      });
      await this.outbox.append(tx, {
        eventType: events.AGENT_UPDATED,
        aggregateType: "agent",
        aggregateId: row.id,
        organizationId,
        payload: { slug: row.slug, changed: Object.keys(diff).sort() },
      });
      await this.audit.log(tx, { eventType: "agent.updated", organizationId, targetType: "agent", targetId: row.id, diff });
      return toAgentRead(row);
    });
  }

  setStatus(organizationId: string, agentId: string, status: "active" | "disabled"): Promise<AgentRead> {
    return this.db.transaction(async (tx) => {
      const current = await this.requireScoped(tx, agentId, organizationId);
      if (current.status === status) return toAgentRead(current);
      const row = await this.agents.setStatus(tx, agentId, status);
      await this.outbox.append(tx, {
        eventType: status === "disabled" ? events.AGENT_DISABLED : events.AGENT_UPDATED,
        aggregateType: "agent",
        aggregateId: row.id,
        organizationId,
        payload: { slug: row.slug, status },
      });
      await this.audit.log(tx, { eventType: `agent.${status}`, organizationId, targetType: "agent", targetId: row.id, diff: { status } });
      return toAgentRead(row);
    });
  }

  delete(organizationId: string, agentId: string): Promise<void> {
    return this.db.transaction(async (tx) => {
      const current = await this.requireScoped(tx, agentId, organizationId);
      await this.agents.softDelete(tx, agentId);
      await this.outbox.append(tx, {
        eventType: events.AGENT_DISABLED,
        aggregateType: "agent",
        aggregateId: current.id,
        organizationId,
        payload: { slug: current.slug, deleted: true },
      });
      await this.audit.log(tx, { eventType: "agent.deleted", organizationId, targetType: "agent", targetId: current.id, diff: {} });
    });
  }

  private async requireScoped(tx: Tx, agentId: string, organizationId: string): Promise<AgentRow> {
    const row = await this.agents.findScoped(tx, agentId, organizationId);
    if (!row) throw new NotFoundError("Agent not found", { agent_id: agentId });
    return row;
  }
}
