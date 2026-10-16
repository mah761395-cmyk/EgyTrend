import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Named, server-owned calculator inputs/results. Archiving is deliberate: a
 * user action never destructively erases a financial scenario.
 */
export const userCalculatorScenariosTable = pgTable("user_calculator_scenarios", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull(),
  calculatorKey: text("calculator_key").notNull(),
  name: text("name").notNull(),
  inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("active"),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("user_calculator_scenarios_user_updated_idx").on(table.userId, table.updatedAt),
  index("user_calculator_scenarios_user_status_idx").on(table.userId, table.status),
]);

/**
 * A compact activity log for explicit user actions (save/copy/export). Inputs
 * are retained for the user's own recent-operation history and are archived,
 * never hard-deleted, by migration rollback paths.
 */
export const userCalculatorActivityTable = pgTable("user_calculator_activity", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull(),
  calculatorKey: text("calculator_key").notNull(),
  action: text("action").notNull(),
  inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("active"),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type UserCalculatorScenario = typeof userCalculatorScenariosTable.$inferSelect;
export type UserCalculatorActivity = typeof userCalculatorActivityTable.$inferSelect;
