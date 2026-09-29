import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";

export interface BillingCustomerRow {
  id: string;
  organization_id: string;
  provider: string;
  provider_customer_id: string | null;
  email: string | null;
  name: string | null;
  tax_id: string | null;
  billing_address: Record<string, unknown>;
  currency: string | null;
}

const COLUMNS = "id, organization_id, provider, provider_customer_id, email, name, tax_id, billing_address, currency";

/**
 * `billing_customers` — one row per org, the local handle on the provider's
 * customer. `(provider, provider_customer_id)` is unique, which is what makes
 * webhook application idempotent.
 */
@Injectable()
export class BillingCustomersRepository {
  findByOrganization(tx: Tx, organizationId: string): Promise<BillingCustomerRow | undefined> {
    return tx.one<BillingCustomerRow>(`SELECT ${COLUMNS} FROM billing_customers WHERE organization_id = $1`, [organizationId]);
  }

  findById(tx: Tx, id: string): Promise<BillingCustomerRow | undefined> {
    return tx.one<BillingCustomerRow>(`SELECT ${COLUMNS} FROM billing_customers WHERE id = $1`, [id]);
  }

  async insert(
    tx: Tx,
    customer: { organizationId: string; provider: string; providerCustomerId: string | null; email: string | null; name: string | null; currency: string },
  ): Promise<BillingCustomerRow> {
    const row = await tx.one<BillingCustomerRow>(
      `INSERT INTO billing_customers (id, organization_id, provider, provider_customer_id, email, name, billing_address, currency)
       VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7) RETURNING ${COLUMNS}`,
      [newUuid(), customer.organizationId, customer.provider, customer.providerCustomerId, customer.email, customer.name, customer.currency],
    );
    return row as BillingCustomerRow;
  }

  /** The org owner's contact details — the fallback when no billing customer exists yet. */
  ownerContact(tx: Tx, organizationId: string): Promise<{ email: string; display_name: string } | undefined> {
    return tx.one<{ email: string; display_name: string }>(
      `SELECT u.email, u.display_name FROM organizations o JOIN users u ON u.id = o.owner_user_id WHERE o.id = $1`,
      [organizationId],
    );
  }

  /**
   * Who gets money and quota mail for an org: the billing customer's address,
   * then `organizations.settings.billing_email`, then the owner (the reference's
   * `billing_recipient`).
   */
  async recipient(tx: Tx, organizationId: string): Promise<string | null> {
    const customer = await this.findByOrganization(tx, organizationId);
    if (customer?.email) return customer.email;
    const org = await tx.one<{ settings: Record<string, unknown> }>(`SELECT settings FROM organizations WHERE id = $1`, [organizationId]);
    const configured = org?.settings.billing_email;
    if (typeof configured === "string" && configured) return configured;
    const owner = await this.ownerContact(tx, organizationId);
    return owner?.email ?? null;
  }
}
