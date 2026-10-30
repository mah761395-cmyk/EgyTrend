import { sql } from "drizzle-orm";
import { check, date, index, integer, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One cash movement that is not a trade: a deposit (cash in), a withdrawal
 * (cash out) or a dividend (cash in from a held asset). The API folds these
 * into the same server-side cash computation as the trade ledger (see
 * artifacts/api-server/src/lib/portfolio-accounting.ts); the client never
 * does portfolio math. The timeline is auditable and soft-archived, matching
 * the trade ledger.
 */
export const portfolioCashEventsTable = pgTable(
  "portfolio_cash_events",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id").notNull(),
    /** 'deposit' | 'withdrawal' | 'dividend' — constrained below. */
    kind: text("kind").notNull(),
    /** Always positive; the kind decides the sign in the cash computation. */
    amount: numeric("amount", { precision: 18, scale: 6 }).notNull(),
    /** Dividend only: which asset paid (catalog instrument id), when known. */
    instrumentId: text("instrument_id"),
    symbol: text("symbol"),
    /** The date the cash moved (Cairo). */
    tradeDate: date("trade_date").notNull(),
    note: text("note"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("portfolio_cash_events_kind_check", sql`kind IN ('deposit','withdrawal','dividend')`),
    check("portfolio_cash_events_amount_check", sql`amount > 0`),
    index("portfolio_cash_events_user_date_idx").on(table.userId, table.tradeDate),
  ],
);

export type PortfolioCashEvent = typeof portfolioCashEventsTable.$inferSelect;
