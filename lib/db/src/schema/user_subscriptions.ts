import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * The current paid entitlement for one application user.
 *
 * Payment requests remain the immutable payment-history record.  This table
 * deliberately stores the plan snapshot used at activation so later admin
 * edits/deactivation of `subscription_plans` cannot shorten or relabel an
 * already-paid subscription.
 */
export const userSubscriptionsTable = pgTable("user_subscriptions", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull(),
  planKey: text("plan_key").notNull(),
  planNameAr: text("plan_name_ar").notNull(),
  planDurationMonths: integer("plan_duration_months").notNull(),
  planFeatures: jsonb("plan_features").$type<string[]>().notNull().default([]),
  /** paid | trial. A trial remains the current entitlement projection too. */
  subscriptionType: text("subscription_type").notNull().default("paid"),
  /** Selected trial features are an entitlement snapshot; null means a paid/legacy term. */
  trialFeatureScope: jsonb("trial_feature_scope").$type<string[] | "all">(),
  /** Server-enforced daily external-AI cap captured when the trial begins. */
  trialAiDailyLimit: integer("trial_ai_daily_limit"),
  trialStartedAt: timestamp("trial_started_at", { withTimezone: true }),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  trialEndedAt: timestamp("trial_ended_at", { withTimezone: true }),
  /** Set when a payment converts a live trial; no later trial sequence may send. */
  trialConvertedAt: timestamp("trial_converted_at", { withTimezone: true }),
  /** active | grace | cancelled | expired. Expiry is also checked at read time. */
  status: text("status").notNull().default("active"),
  /** A fresh opaque value per paid term, used to deduplicate reminders safely across renewals. */
  cycleId: text("cycle_id").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  /** Stored in UTC: monthly terms are exactly 30 × 24 hours, never calendar-month arithmetic. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Access may remain during this admin-configured period; null means no grace period. */
  graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
  /** Last approved request that extended this entitlement; payment history lives separately. */
  paymentRequestId: text("payment_request_id"),
  /** payment | legacy_backfill | admin_revocation, never a client-supplied value. */
  source: text("source").notNull().default("payment"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("user_subscriptions_user_id_uidx").on(table.userId),
]);

export type UserSubscription = typeof userSubscriptionsTable.$inferSelect;
