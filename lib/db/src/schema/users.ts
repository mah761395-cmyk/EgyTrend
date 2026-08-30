import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const appUsersTable = pgTable("app_users", {
  id: serial("id").primaryKey(),
  phone: text("phone").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  plan: text("plan").notNull().default("free"),
  vipExpiresAt: timestamp("vip_expires_at"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type AppUser = typeof appUsersTable.$inferSelect;