import { integer, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * User-entered portfolio lots. Market prices are intentionally not stored here:
 * every display value comes from the licensed market-data service at read time
 * and carries its own source/as-of metadata.
 */
export const portfolioPositionsTable = pgTable("portfolio_positions", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull(),
  instrumentId: text("instrument_id").notNull(),
  symbol: text("symbol").notNull(),
  quantity: integer("quantity").notNull(),
  /** User-entered average entry cost, stored exactly as decimal text by PostgreSQL. */
  averageCost: numeric("average_cost", { precision: 18, scale: 6 }).notNull(),
  currency: text("currency").notNull().default("EGP"),
  status: text("status").notNull().default("active"),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("portfolio_positions_user_symbol_uidx").on(table.userId, table.symbol),
]);

export type PortfolioPosition = typeof portfolioPositionsTable.$inferSelect;
