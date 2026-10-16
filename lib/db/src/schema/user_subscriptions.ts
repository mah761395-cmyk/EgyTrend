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
  /** active | cancelled | expired. Expiry is also checked at read time. */
  status: text("status").notNull().default("active"),
  startsAt: timestamp("starts_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
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
