import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { appUsersTable } from "./users";
import { employeesTable } from "./employees";
import type { BroadcastAction } from "./broadcast_messages";

export const TRIAL_MESSAGE_TIMINGS = ["after_start", "before_end", "at_end", "after_end"] as const;
export type TrialMessageTiming = typeof TRIAL_MESSAGE_TIMINGS[number];
export const TRIAL_MESSAGE_CHANNELS = ["in_app", "modal", "email"] as const;
export type TrialMessageChannel = typeof TRIAL_MESSAGE_CHANNELS[number];
export const TRIAL_MESSAGE_STATUSES = ["active", "paused", "archived"] as const;
export type TrialMessageStatus = typeof TRIAL_MESSAGE_STATUSES[number];

/**
 * Canonical-email eligibility evidence survives the one-row current
 * entitlement projection. IP/device values are privacy-preserving review
 * signals only and deliberately have no uniqueness constraint.
 */
export const trialClaimsTable = pgTable("trial_claims", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "restrict" }),
  canonicalEmail: text("canonical_email").notNull(),
  trialSubscriptionId: text("trial_subscription_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  convertedAt: timestamp("converted_at", { withTimezone: true }),
  paidStartsAt: timestamp("paid_starts_at", { withTimezone: true }),
  ipSignalHash: text("ip_signal_hash"),
  deviceSignalHash: text("device_signal_hash"),
  manualOverride: boolean("manual_override").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("trial_claims_user_uidx").on(table.userId),
  uniqueIndex("trial_claims_canonical_email_uidx").on(table.canonicalEmail),
  index("trial_claims_started_idx").on(table.startedAt),
  index("trial_claims_converted_idx").on(table.convertedAt),
]);

/** Single-use verification links store only a SHA-256 token digest. */
export const emailVerificationTokensTable = pgTable("email_verification_tokens", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("email_verification_tokens_hash_idx").on(table.tokenHash),
  index("email_verification_tokens_user_idx").on(table.userId, table.createdAt),
]);

/**
 * Editable, versioned trial sequence. Archiving never deletes a row, and a
 * version bump means only future deliveries use the new message snapshot.
 */
export const freeTrialMessageStepsTable = pgTable("free_trial_message_steps", {
  id: text("id").primaryKey(),
  timing: text("timing").notNull(),
  offsetDays: integer("offset_days").notNull().default(0),
  channels: jsonb("channels").$type<TrialMessageChannel[]>().notNull().default([]),
  titleTemplate: text("title_template").notNull(),
  bodyTemplate: text("body_template").notNull(),
  messageType: text("message_type").notNull().default("important"),
  /** User-facing CTA is always constructed server-side as /vip?plan=… . */
  actionLabel: text("action_label"),
  actionPlanKey: text("action_plan_key"),
  /** Reserved for a future server-side redemption implementation; null today. */
  couponCode: text("coupon_code"),
  emailMarketing: boolean("email_marketing").notNull().default(false),
  status: text("status").notNull().default("active"),
  version: integer("version").notNull().default(1),
  createdBy: integer("created_by").references(() => employeesTable.id, { onDelete: "set null" }),
  updatedBy: integer("updated_by").references(() => employeesTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [
  index("free_trial_message_steps_status_idx").on(table.status, table.timing, table.offsetDays),
]);

/** Shape consumed by services; exported here to keep Drizzle JSON types stable. */
export type TrialStepAction = BroadcastAction;
export type TrialClaim = typeof trialClaimsTable.$inferSelect;
export type FreeTrialMessageStep = typeof freeTrialMessageStepsTable.$inferSelect;
