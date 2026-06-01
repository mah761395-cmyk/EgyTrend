import { pgTable, serial, boolean, integer, timestamp, text } from "drizzle-orm/pg-core";

export const aiConfigTable = pgTable("ai_config", {
  id: serial("id").primaryKey(),
  analyzerEnabled: boolean("analyzer_enabled").default(true),
  summaryEnabled: boolean("summary_enabled").default(true),
  rewriterEnabled: boolean("rewriter_enabled").default(true),
  dailyRequestLimit: integer("daily_request_limit").default(1000),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: text("updated_by"),
});

export const aiUsageTable = pgTable("ai_usage", {
  id: serial("id").primaryKey(),
  userId: text("user_id"),
  requestType: text("request_type").notNull(),
  tokensEstimate: integer("tokens_estimate").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AiConfig = typeof aiConfigTable.$inferSelect;
export type AiUsage = typeof aiUsageTable.$inferSelect;
