import { boolean, pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";

/**
 * Per-user in-platform notification delivery preferences.
 * Only the ambient families are toggleable: account-critical notifications
 * (payment decisions, subscription lifecycle, explicitly-created price
 * alerts' e-mail) are always delivered regardless of these rows.
 * Absence of a row means the default (enabled) — users start receiving
 * everything and opt out explicitly.
 */
export const userNotificationPrefsTable = pgTable(
  "user_notification_prefs",
  {
    phone: text("phone").notNull(),
    /** "price" | "opps" | "news" — one row per (phone, kind). */
    kind: text("kind").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.phone, t.kind] })],
);

export type UserNotificationPrefs = typeof userNotificationPrefsTable.$inferSelect;
