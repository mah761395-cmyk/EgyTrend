import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Simple editable key/value store (payment price, wallet number, ...).
 *  Managed by admins via /api/admin/settings — never exposed to clients
 *  except through the deliberate public subset in /api/payments/config. */
export const appSettingsTable = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type AppSetting = typeof appSettingsTable.$inferSelect;
