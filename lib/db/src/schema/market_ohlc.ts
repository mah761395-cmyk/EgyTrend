import { date, doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * End-of-day, normalized market snapshots. This table is append-oriented: a
 * provider correction updates the same source/instrument/trading-day row; no
 * user data or credentials are stored here.
 *
 * The accompanying SQL migration is intentionally NOT applied by this change.
 */
export const marketDailyOhlcTable = pgTable("market_daily_ohlc", {
  id: text("id").primaryKey(),
  instrumentId: text("instrument_id").notNull(),
  sourceId: text("source_id").notNull(),
  sourceName: text("source_name").notNull(),
  tradingDate: date("trading_date", { mode: "string" }).notNull(),
  open: doublePrecision("open").notNull(),
  high: doublePrecision("high").notNull(),
  low: doublePrecision("low").notNull(),
  close: doublePrecision("close").notNull(),
  volume: doublePrecision("volume"),
  currency: text("currency"),
  delayedMinutes: integer("delayed_minutes"),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("market_daily_ohlc_source_instrument_day_uq").on(table.sourceId, table.instrumentId, table.tradingDate),
  index("market_daily_ohlc_instrument_day_idx").on(table.instrumentId, table.tradingDate),
]);

export type MarketDailyOhlc = typeof marketDailyOhlcTable.$inferSelect;
