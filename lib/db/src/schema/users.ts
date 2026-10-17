import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const appUsersTable = pgTable("app_users", {
  id: serial("id").primaryKey(),
  phone: text("phone").notNull().unique(),
  email: text("email"), // optional — used for password-reset emails and (later) account login
  /** Explicit account consent only; never inferred from providing a recovery email. */
  marketingEmailOptIn: boolean("marketing_email_opt_in").notNull().default(false),
  marketingEmailOptedInAt: timestamp("marketing_email_opted_in_at", { withTimezone: true }),
  marketingEmailUnsubscribedAt: timestamp("marketing_email_unsubscribed_at", { withTimezone: true }),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  plan: text("plan").notNull().default("free"),
  vipExpiresAt: timestamp("vip_expires_at"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type AppUser = typeof appUsersTable.$inferSelect;

/* Password-reset tokens: short-lived, single-use. Only a SHA-256 hash of the
 * raw token is stored — a DB leak cannot be replayed against the endpoint. */
export const passwordResetsTable = pgTable("password_resets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});