/**
 * Canonical event-type vocabulary (`contracts/events.json`): one set of names
 * for audit_logs.event_type and outbox_events.event_type.
 */
export const events = {
  USER_REGISTERED: "user.registered",
  USER_LOGIN_SUCCEEDED: "user.login_succeeded",
  USER_LOGIN_FAILED: "user.login_failed",
  USER_TOKEN_REFRESHED: "user.token_refreshed",
  USER_TOKEN_REUSE_DETECTED: "user.token_reuse_detected",
  USER_LOGGED_OUT: "user.logged_out",
  USER_PASSWORD_RESET_REQUESTED: "user.password_reset_requested",
  USER_PASSWORD_RESET_COMPLETED: "user.password_reset_completed",
  ORG_CREATED: "org.created",
  ORG_UPDATED: "org.updated",
  ORG_SUSPENDED: "org.suspended",
  ORG_UNSUSPENDED: "org.unsuspended",
  MEMBER_INVITED: "member.invited",
  MEMBER_JOINED: "member.joined",
  MEMBER_UPDATED: "member.updated",
  MEMBER_REMOVED: "member.removed",
  ROLE_CREATED: "role.created",
  ROLE_UPDATED: "role.updated",
  ROLE_DELETED: "role.deleted",
  API_KEY_CREATED: "api_key.created",
  API_KEY_REVOKED: "api_key.revoked",
  // Subscriptions / entitlements / billing
  SUBSCRIPTION_TRIAL_STARTED: "subscription.trial_started",
  SUBSCRIPTION_ACTIVATED: "subscription.activated",
  SUBSCRIPTION_UPDATED: "subscription.updated",
  SUBSCRIPTION_PLAN_CHANGED: "subscription.plan_changed",
  SUBSCRIPTION_CANCELED: "subscription.canceled",
  SUBSCRIPTION_RESUMED: "subscription.resumed",
  SUBSCRIPTION_PAST_DUE: "subscription.past_due",
  SUBSCRIPTION_EXPIRED: "subscription.expired",
  ENTITLEMENT_GRANTED: "entitlement.granted",
  ENTITLEMENT_REVOKED: "entitlement.revoked",
  ENTITLEMENT_EXPIRED: "entitlement.expired",
  INVOICE_CREATED: "invoice.created",
  INVOICE_PAID: "invoice.paid",
  INVOICE_FAILED: "invoice.failed",
  // Usage
  USAGE_SOFT_LIMIT_REACHED: "usage.soft_limit_reached",
  USAGE_HARD_LIMIT_REACHED: "usage.hard_limit_reached",
  // Internal (in-process consumers only — never fanned out to tenant webhooks)
  MEMBER_INVITE_EMAIL: "member.invite_email",
  USER_PASSWORD_RESET_LINK: "user.password_reset_link",
  INVOICE_EMAIL: "invoice.email",
  AUTHZ_TUPLES_CHANGED: "authz.tuples_changed",
} as const;

export type EventType = (typeof events)[keyof typeof events];

export const INTERNAL_EVENTS: ReadonlySet<string> = new Set([
  events.MEMBER_INVITE_EMAIL,
  events.USER_PASSWORD_RESET_LINK,
  events.INVOICE_EMAIL,
  events.AUTHZ_TUPLES_CHANGED,
]);

export const AUDIENCE_PUBLIC = "public";
export const AUDIENCE_INTERNAL = "internal";

export function audienceFor(eventType: string): "public" | "internal" {
  return INTERNAL_EVENTS.has(eventType) ? AUDIENCE_INTERNAL : AUDIENCE_PUBLIC;
}
