import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { appUsersTable } from "./users";
import { userSubscriptionsTable } from "./user_subscriptions";
import type { BroadcastAction, BroadcastContent } from "./broadcast_messages";

/** Immutable snapshot used for a trial-sequence delivery. The raw admin
 * template is never sent to a member; variables are resolved and the safe
 * Broadcast AST is saved at reservation time. */
export type TrialMessageSnapshot = {
  kind: "free_trial";
  stepId: string;
  stepVersion: number;
  channels: Array<"in_app" | "modal" | "email">;
  messageType: "offer" | "greeting" | "new_feature" | "maintenance" | "important";
  content: BroadcastContent;
  action: BroadcastAction;
  variableSource: "current_server_price" | "not_requested" | "unavailable";
  generatedAt: string;
};

export type SubscriptionReminderContent = {
  title: string;
  body: string;
  actionUrl: string;
  actionLabel: string;
  emailSubject: string;
  emailHtml: string;
  transactional: boolean;
  /** Existing paid reminders omit this; trial messages carry their exact safe snapshot. */
  trial?: TrialMessageSnapshot;
};

/**
 * One row is reserved per subscription term/cycle and reminder type before
 * delivery begins. The unique index is the durable idempotency boundary for
 * a daily scheduler that may be invoked more than once or retried.
 */
/* Generic name intentionally leaves room for future trial/referral reminder cycles. */
export const subscriptionRemindersSentTable = pgTable("reminders_sent", {
  id: text("id").primaryKey(),
  subscriptionId: text("subscription_id").notNull().references(() => userSubscriptionsTable.id, { onDelete: "restrict" }),
  /** `user_subscriptions` is a current-entitlement projection; this changes on each approved renewal. */
  subscriptionCycleId: text("subscription_cycle_id").notNull(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "restrict" }),
  reminderType: text("reminder_type").notNull(),
  reminderClass: text("reminder_class").notNull().default("transactional"),
  /** Null for paid lifecycle reminders; identifies sequence analytics safely. */
  trialMessageStepId: text("trial_message_step_id"),
  targetEndsAt: timestamp("target_ends_at", { withTimezone: true }).notNull(),
  deliveryStatus: text("delivery_status").notNull().default("queued"),
  content: jsonb("content").$type<SubscriptionReminderContent>().notNull(),
  inAppNotificationId: text("in_app_notification_id"),
  inAppSentAt: timestamp("in_app_sent_at", { withTimezone: true }),
  emailStatus: text("email_status").notNull().default("pending"),
  emailAttempts: integer("email_attempts").notNull().default(0),
  emailNextAttemptAt: timestamp("email_next_attempt_at", { withTimezone: true }),
  /** Lease token prevents a slow/retried worker from overwriting a newer delivery result. */
  emailClaimToken: text("email_claim_token"),
  emailClaimedAt: timestamp("email_claimed_at", { withTimezone: true }),
  emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
  /** A safe category only, never SMTP/vendor text that may expose credentials. */
  emailLastError: text("email_last_error"),
  /** Account-scoped engagement events, written by authenticated trial-message APIs. */
  openedAt: timestamp("opened_at", { withTimezone: true }),
  clickedAt: timestamp("clicked_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("subscription_reminders_sent_cycle_type_uidx").on(table.subscriptionCycleId, table.reminderType),
  index("subscription_reminders_sent_delivery_idx").on(table.deliveryStatus, table.targetEndsAt),
  index("subscription_reminders_sent_email_idx").on(table.emailStatus, table.emailNextAttemptAt),
  index("subscription_reminders_sent_user_idx").on(table.userId, table.createdAt),
  index("subscription_reminders_sent_trial_step_idx").on(table.trialMessageStepId, table.createdAt),
]);

/** Immutable, non-financial lifecycle evidence for the admin renewal metrics. */
export const subscriptionLifecycleEventsTable = pgTable("subscription_lifecycle_events", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "restrict" }),
  subscriptionId: text("subscription_id").notNull().references(() => userSubscriptionsTable.id, { onDelete: "restrict" }),
  subscriptionCycleId: text("subscription_cycle_id").notNull(),
  /** activated | renewed | grace_started | expired | cancelled */
  eventType: text("event_type").notNull(),
  relatedCycleId: text("related_cycle_id"),
  planKey: text("plan_key").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("subscription_lifecycle_events_cycle_type_uidx").on(table.subscriptionCycleId, table.eventType),
  index("subscription_lifecycle_events_type_at_idx").on(table.eventType, table.occurredAt),
  index("subscription_lifecycle_events_user_idx").on(table.userId, table.occurredAt),
]);

export type SubscriptionReminderSent = typeof subscriptionRemindersSentTable.$inferSelect;
export type SubscriptionLifecycleEvent = typeof subscriptionLifecycleEventsTable.$inferSelect;
