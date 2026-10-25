import { boolean, integer, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Server-owned user alert rules. Trigger values retain their exact decimal form. */
export const userPriceAlertsTable = pgTable("user_price_alerts", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull(),
  instrumentId: text("instrument_id").notNull(),
  symbol: text("symbol").notNull(),
  /** price_above | price_below | change_percent_above | change_percent_below */
  condition: text("condition").notNull(),
  targetValue: numeric("target_value", { precision: 18, scale: 6 }).notNull(),
  emailEnabled: boolean("email_enabled").notNull().default(false),
  status: text("status").notNull().default("active"),
  lastEvaluatedAt: timestamp("last_evaluated_at"),
  triggeredAt: timestamp("triggered_at"),
  triggerValue: numeric("trigger_value", { precision: 18, scale: 6 }),
  triggerSource: text("trigger_source"),
  triggerAsOf: timestamp("trigger_as_of"),
  emailStatus: text("email_status").notNull().default("not_requested"),
  emailSentAt: timestamp("email_sent_at"),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("user_price_alerts_active_rule_uidx").on(table.userId, table.symbol, table.condition, table.targetValue),
]);

export type UserPriceAlert = typeof userPriceAlertsTable.$inferSelect;
