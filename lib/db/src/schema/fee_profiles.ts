import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** One line of a user's broker fee schedule. `percent` and/or `minimum`
 * (Egyptian pounds) apply to the buy and/or sell notional:
 * fee = max(percent/100 × notional, minimum). The platform never defaults a
 * rate — both values are entered by the user for their own broker. */
export type FeeProfileItem = {
  key: string;
  labelAr: string;
  side: "buy" | "sell" | "both";
  percent: number;
  minimum: number;
};

/**
 * A named, user-owned fee schedule for the fee-based trade calculator.
 * Items reference the admin-managed fee catalog (app_settings row
 * `calculator_fee_items`); values always belong to the user, never to the
 * platform.
 */
export const userFeeProfilesTable = pgTable("user_fee_profiles", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  items: jsonb("items").$type<FeeProfileItem[]>().notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("user_fee_profiles_user_name_uidx").on(table.userId, table.name),
  index("user_fee_profiles_user_status_idx").on(table.userId, table.status),
]);
