import { sql } from "drizzle-orm";
import { check, integer, numeric, pgTable, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-user portfolio cash settings. `startingCash` is the user-declared cash
 * balance before the recorded trades; the live cash balance is
 * `startingCash + sell proceeds − buy outlays` (fees included), computed
 * server-side from the transaction ledger.
 */
export const portfolioSettingsTable = pgTable(
  "portfolio_settings",
  {
    userId: integer("user_id").primaryKey().notNull(),
    startingCash: numeric("starting_cash", { precision: 18, scale: 6 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("portfolio_settings_starting_cash_check", sql`starting_cash >= 0`)],
);

export type PortfolioSettings = typeof portfolioSettingsTable.$inferSelect;
