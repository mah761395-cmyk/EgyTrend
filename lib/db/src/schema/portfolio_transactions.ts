import { sql } from "drizzle-orm";
import { check, date, index, integer, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One buy or sell trade, recorded by the user. Positions, average cost,
 * realized P/L and cash are derived from this ledger server-side (see
 * artifacts/api-server/src/lib/portfolio-accounting.ts) — the client never
 * does portfolio math. Market prices are intentionally not stored here:
 * every display value comes from the licensed market-data service at read
 * time and carries its own source/as-of metadata.
 */
export const portfolioTransactionsTable = pgTable(
  "portfolio_transactions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id").notNull(),
    instrumentId: text("instrument_id").notNull(),
    symbol: text("symbol").notNull(),
    /** 'buy' | 'sell' — constrained in the table callback below. */
    side: text("side").notNull(),
    quantity: integer("quantity").notNull(),
    /** Price per share in EGP at the time of the trade. */
    price: numeric("price", { precision: 18, scale: 6 }).notNull(),
    /** Broker/commission costs for this trade in EGP (>= 0). */
    fees: numeric("fees", { precision: 18, scale: 6 }).notNull().default("0"),
    currency: text("currency").notNull().default("EGP"),
    tradeDate: date("trade_date").notNull(),
    note: text("note"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("portfolio_transactions_side_check", sql`side IN ('buy','sell')`),
    check("portfolio_transactions_quantity_check", sql`quantity > 0`),
    check("portfolio_transactions_price_check", sql`price > 0`),
    check("portfolio_transactions_fees_check", sql`fees >= 0`),
    index("portfolio_transactions_user_date_idx").on(table.userId, table.tradeDate),
  ],
);

export type PortfolioTransaction = typeof portfolioTransactionsTable.$inferSelect;
