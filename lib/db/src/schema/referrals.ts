import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { appUsersTable } from "./users";
import { employeesTable } from "./employees";
import { couponsTable } from "./coupons";

/**
 * Referral state is intentionally durable and server-owned. Campaign rule
 * snapshots live on the attribution/reward rows so editing or archiving a
 * campaign can only affect future attributions, never rewrite earned history.
 */
export const REFERRAL_QUALIFICATION_EVENTS = ["email_verified", "trial_started", "first_paid"] as const;
export type ReferralQualificationEvent = typeof REFERRAL_QUALIFICATION_EVENTS[number];
export const REFERRAL_CAMPAIGN_STATUSES = ["active", "paused", "archived"] as const;
export type ReferralCampaignStatus = typeof REFERRAL_CAMPAIGN_STATUSES[number];
export const REFERRAL_REWARD_STATUSES = ["pending", "eligible", "granted", "cancelled", "withdrawn"] as const;
export type ReferralRewardStatus = typeof REFERRAL_REWARD_STATUSES[number];
export const REFERRAL_REWARD_TYPES = ["vip_days", "coupon", "renewal_credit", "first_subscription_percent", "first_subscription_amount", "trial_extra_days"] as const;
export type ReferralRewardType = typeof REFERRAL_REWARD_TYPES[number];

export const referralProgramSettingsTable = pgTable("referral_program_settings", {
  /** Singleton row with id `default`; keeps feature disabled by default. */
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  attributionCookieDays: integer("attribution_cookie_days").notNull().default(30),
  termsText: text("terms_text").notNull().default(""),
  updatedBy: integer("updated_by").references(() => employeesTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A scheduled, prioritized server-side reward rule. */
export const referralCampaignsTable = pgTable("referral_campaigns", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("paused"),
  priority: integer("priority").notNull().default(0),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  qualificationEvent: text("qualification_event").notNull().default("first_paid"),
  holdDays: integer("hold_days").notNull().default(7),
  referrerRewardType: text("referrer_reward_type").notNull(),
  referrerRewardValue: integer("referrer_reward_value").notNull(),
  /** Optional server-side cost estimate; never invent a financial result when missing. */
  referrerRewardCost: integer("referrer_reward_cost"),
  inviteeRewardType: text("invitee_reward_type").notNull().default("first_subscription_percent"),
  inviteeRewardValue: integer("invitee_reward_value").notNull().default(0),
  inviteeRewardCost: integer("invitee_reward_cost"),
  maxReferrerMonthly: integer("max_referrer_monthly"),
  maxReferrerTotal: integer("max_referrer_total"),
  createdBy: integer("created_by").references(() => employeesTable.id, { onDelete: "set null" }),
  updatedBy: integer("updated_by").references(() => employeesTable.id, { onDelete: "set null" }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("referral_campaigns_schedule_idx").on(table.status, table.startsAt, table.endsAt, table.priority),
]);

/** Extra milestone reward, scoped to a campaign and archived instead of deleted. */
export const referralTiersTable = pgTable("referral_tiers", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull().references(() => referralCampaignsTable.id, { onDelete: "restrict" }),
  threshold: integer("threshold").notNull(),
  rewardType: text("reward_type").notNull(),
  rewardValue: integer("reward_value").notNull(),
  rewardCost: integer("reward_cost"),
  status: text("status").notNull().default("active"),
  createdBy: integer("created_by").references(() => employeesTable.id, { onDelete: "set null" }),
  updatedBy: integer("updated_by").references(() => employeesTable.id, { onDelete: "set null" }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("referral_tiers_campaign_threshold_uidx").on(table.campaignId, table.threshold),
  index("referral_tiers_campaign_status_idx").on(table.campaignId, table.status),
]);

/**
 * Every ordinary account has one opaque 8-character code created lazily.
 * Special/partner codes may have a readable admin-picked value and can point
 * at a campaign or a captured rule override. Codes are always normalized to
 * uppercase on the server before persistence and comparison.
 */
export const referralCodesTable = pgTable("referral_codes", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  kind: text("kind").notNull().default("user"),
  ownerUserId: integer("owner_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  campaignId: text("campaign_id").references(() => referralCampaignsTable.id, { onDelete: "set null" }),
  ruleOverride: jsonb("rule_override").$type<Record<string, unknown> | null>(),
  label: text("label"),
  status: text("status").notNull().default("active"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** Accounting-only amount entered by staff; no automatic payout exists. */
  commissionDue: integer("commission_due").notNull().default(0),
  commissionNotes: text("commission_notes"),
  createdBy: integer("created_by").references(() => employeesTable.id, { onDelete: "set null" }),
  updatedBy: integer("updated_by").references(() => employeesTable.id, { onDelete: "set null" }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("referral_codes_code_uidx").on(table.code),
  uniqueIndex("referral_codes_active_user_owner_uidx").on(table.ownerUserId).where(sql`${table.kind} = 'user' and ${table.status} = 'active' and ${table.archivedAt} is null`),
  index("referral_codes_owner_user_idx").on(table.ownerUserId),
  index("referral_codes_campaign_status_idx").on(table.campaignId, table.status, table.expiresAt),
]);

/** One immutable referral relationship per newly registered invitee. */
export const referralAttributionsTable = pgTable("referral_attributions", {
  id: text("id").primaryKey(),
  invitedUserId: integer("invited_user_id").notNull().references(() => appUsersTable.id, { onDelete: "restrict" }),
  referrerUserId: integer("referrer_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  codeId: text("code_id").notNull().references(() => referralCodesTable.id, { onDelete: "restrict" }),
  campaignId: text("campaign_id").notNull().references(() => referralCampaignsTable.id, { onDelete: "restrict" }),
  codeSnapshot: text("code_snapshot").notNull(),
  /** Complete rule snapshot used for all later qualification/reward behavior. */
  ruleSnapshot: jsonb("rule_snapshot").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("registered"),
  reviewStatus: text("review_status").notNull().default("not_required"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  trialStartedAt: timestamp("trial_started_at", { withTimezone: true }),
  firstPaidAt: timestamp("first_paid_at", { withTimezone: true }),
  paymentRequestId: text("payment_request_id"),
  ipSignalHash: text("ip_signal_hash"),
  deviceSignalHash: text("device_signal_hash"),
  suspicious: boolean("suspicious").notNull().default(false),
  blockedReason: text("blocked_reason"),
  reviewReason: text("review_reason"),
  reviewedBy: integer("reviewed_by").references(() => employeesTable.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("referral_attributions_invited_user_uidx").on(table.invitedUserId),
  index("referral_attributions_referrer_idx").on(table.referrerUserId, table.createdAt),
  index("referral_attributions_review_idx").on(table.reviewStatus, table.createdAt),
  index("referral_attributions_code_idx").on(table.codeId, table.createdAt),
]);

/** Privacy-preserving fraud/review facts. No raw IP, device, receipt or phone is stored here. */
export const referralReviewSignalsTable = pgTable("referral_review_signals", {
  id: text("id").primaryKey(),
  attributionId: text("attribution_id").notNull().references(() => referralAttributionsTable.id, { onDelete: "cascade" }),
  signalType: text("signal_type").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("referral_review_signals_attribution_type_uidx").on(table.attributionId, table.signalType),
  index("referral_review_signals_type_idx").on(table.signalType, table.createdAt),
]);

/** Durable reward state and idempotency key for referrer, invitee and tier rewards. */
export const referralRewardsTable = pgTable("referral_rewards", {
  id: text("id").primaryKey(),
  attributionId: text("attribution_id").references(() => referralAttributionsTable.id, { onDelete: "restrict" }),
  campaignId: text("campaign_id").notNull().references(() => referralCampaignsTable.id, { onDelete: "restrict" }),
  tierId: text("tier_id").references(() => referralTiersTable.id, { onDelete: "restrict" }),
  recipientUserId: integer("recipient_user_id").notNull().references(() => appUsersTable.id, { onDelete: "restrict" }),
  recipientRole: text("recipient_role").notNull(),
  rewardType: text("reward_type").notNull(),
  rewardValue: integer("reward_value").notNull(),
  estimatedCost: integer("estimated_cost"),
  status: text("status").notNull().default("pending"),
  qualificationEvent: text("qualification_event").notNull(),
  holdUntil: timestamp("hold_until", { withTimezone: true }),
  paymentRequestId: text("payment_request_id"),
  couponId: integer("coupon_id").references(() => couponsTable.id, { onDelete: "set null" }),
  idempotencyKey: text("idempotency_key").notNull(),
  ruleSnapshot: jsonb("rule_snapshot").$type<Record<string, unknown>>().notNull().default({}),
  grantSnapshot: jsonb("grant_snapshot").$type<Record<string, unknown> | null>(),
  reason: text("reason"),
  grantedBy: integer("granted_by").references(() => employeesTable.id, { onDelete: "set null" }),
  grantedAt: timestamp("granted_at", { withTimezone: true }),
  cancelledBy: integer("cancelled_by").references(() => employeesTable.id, { onDelete: "set null" }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("referral_rewards_idempotency_uidx").on(table.idempotencyKey),
  index("referral_rewards_status_hold_idx").on(table.status, table.holdUntil),
  index("referral_rewards_recipient_idx").on(table.recipientUserId, table.createdAt),
  index("referral_rewards_attribution_idx").on(table.attributionId, table.createdAt),
]);

/** Append-only audit trail for each reward state change and staff intervention. */
export const referralRewardLedgerTable = pgTable("referral_reward_ledger", {
  id: text("id").primaryKey(),
  rewardId: text("reward_id").notNull().references(() => referralRewardsTable.id, { onDelete: "restrict" }),
  action: text("action").notNull(),
  reason: text("reason"),
  actorEmployeeId: integer("actor_employee_id").references(() => employeesTable.id, { onDelete: "set null" }),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("referral_reward_ledger_reward_idx").on(table.rewardId, table.createdAt),
]);

/** Editable transactional notification/email templates for referral events. */
export const referralMessageTemplatesTable = pgTable("referral_message_templates", {
  id: text("id").primaryKey(),
  eventKey: text("event_key").notNull(),
  channels: jsonb("channels").$type<string[]>().notNull().default(["in_app"]),
  titleTemplate: text("title_template").notNull(),
  bodyTemplate: text("body_template").notNull(),
  status: text("status").notNull().default("active"),
  version: integer("version").notNull().default(1),
  updatedBy: integer("updated_by").references(() => employeesTable.id, { onDelete: "set null" }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("referral_message_templates_event_uidx").on(table.eventKey),
]);

/** Delivery reservation prevents duplicate notifications/e-mails across retries/workers. */
export const referralMessageDeliveriesTable = pgTable("referral_message_deliveries", {
  id: text("id").primaryKey(),
  deliveryKey: text("delivery_key").notNull(),
  recipientUserId: integer("recipient_user_id").notNull().references(() => appUsersTable.id, { onDelete: "restrict" }),
  templateId: text("template_id").references(() => referralMessageTemplatesTable.id, { onDelete: "set null" }),
  eventKey: text("event_key").notNull(),
  notificationId: text("notification_id"),
  emailStatus: text("email_status").notNull().default("not_requested"),
  contentSnapshot: jsonb("content_snapshot").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("referral_message_deliveries_key_uidx").on(table.deliveryKey),
  index("referral_message_deliveries_recipient_idx").on(table.recipientUserId, table.createdAt),
]);

/** Valid referral-link hits are counted for the funnel without retaining raw network identity. */
export const referralClickEventsTable = pgTable("referral_click_events", {
  id: text("id").primaryKey(),
  codeId: text("code_id").notNull().references(() => referralCodesTable.id, { onDelete: "restrict" }),
  campaignId: text("campaign_id").references(() => referralCampaignsTable.id, { onDelete: "set null" }),
  visitorSignalHash: text("visitor_signal_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("referral_click_events_campaign_idx").on(table.campaignId, table.createdAt),
  index("referral_click_events_code_idx").on(table.codeId, table.createdAt),
]);

export type ReferralCampaign = typeof referralCampaignsTable.$inferSelect;
export type ReferralCode = typeof referralCodesTable.$inferSelect;
export type ReferralAttribution = typeof referralAttributionsTable.$inferSelect;
export type ReferralReward = typeof referralRewardsTable.$inferSelect;
