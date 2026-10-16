import { pgTable, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { subscriptionPlansTable } from "./plans";

/**
 * Immutable before/after snapshots for an operator's pricing change. The
 * application marks a row as reverted instead of deleting it, which allows a
 * safe one-click undo of the latest outstanding change.
 */
export const planPriceChangeLogsTable = pgTable("plan_price_change_logs", {
  id: text("id").primaryKey(),
  planId: integer("plan_id").notNull().references(() => subscriptionPlansTable.id, { onDelete: "restrict" }),
  changedBy: integer("changed_by"),
  changedByName: text("changed_by_name"),
  changedByRole: text("changed_by_role"),
  changeType: text("change_type").notNull().default("pricing_update"),
  beforeState: jsonb("before_state").$type<Record<string, unknown>>().notNull(),
  afterState: jsonb("after_state").$type<Record<string, unknown>>().notNull(),
  revertedAt: timestamp("reverted_at", { withTimezone: true }),
  revertedBy: integer("reverted_by"),
  revertedByName: text("reverted_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type PlanPriceChangeLog = typeof planPriceChangeLogsTable.$inferSelect;
