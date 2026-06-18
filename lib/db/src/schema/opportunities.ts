import { pgTable, varchar, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const opportunities = pgTable("opportunities", {
  id: varchar("id", { length: 50 }).primaryKey(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  details: text("details"),
  type: varchar("type", { length: 50 }).notNull(),
  market: varchar("market", { length: 50 }).notNull(),
  expectedReturn: varchar("expected_return", { length: 100 }),
  riskLevel: integer("risk_level").notNull().default(3),
  sector: varchar("sector", { length: 100 }),
  duration: varchar("duration", { length: 100 }),
  deadline: varchar("deadline", { length: 100 }),
  status: varchar("status", { length: 30 }).notNull().default("active"),
  featured: boolean("featured").notNull().default(false),
  vipOnly: boolean("vip_only").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
