import { pgTable, text, timestamp, primaryKey, index } from "drizzle-orm/pg-core";

/**
 * EGX symbols a user follows for news matching. The client's local watchlist
 * stays the UI of record; this mirror exists so the scheduled news cycle can
 * tell, server-side, which users a new story about a stock or its sector
 * affects. Symbols are validated against the curated EGX catalog.
 */
export const userFollowsTable = pgTable(
  "user_follows",
  {
    phone: text("phone").notNull(),
    symbol: text("symbol").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.phone, t.symbol] }),
    index("user_follows_phone_idx").on(t.phone),
  ],
);

export type UserFollow = typeof userFollowsTable.$inferSelect;
