/* In-platform user notifications, currently driven by payment decisions.
 * Rows are inserted server-side (admin approve/reject in admin.ts); the
 * client polls /api/user/notifications and shows them via the bell button.
 * Per-user read state is tracked on the client by readAt sync (cheap,
 * non-sensitive); delivery is per-phone so any device of the same account
 * sees the same feed. */
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const userNotificationsTable = pgTable(
  "user_notifications",
  {
    id: text("id").primaryKey(),
    phone: text("phone").notNull(),
    kind: text("kind").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("user_notifications_phone_idx").on(t.phone)],
);

export type UserNotification = typeof userNotificationsTable.$inferSelect;
