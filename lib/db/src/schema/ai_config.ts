import { pgTable, serial, boolean, integer, doublePrecision, timestamp, text } from "drizzle-orm/pg-core";

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
  /** Actual serving provider for this call (null on legacy/failed-before-dispatch rows). */
  provider: text("provider"),
  model: text("model"),
  /** Real token counts reported by the provider (null when not metered). */
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  /** reserved → ok | failed. A row is written exactly once per external call. */
  status: text("status").notNull().default("reserved"),
  /** Estimated cost in USD computed from the provider-reported tokens and the
   *  editable model price table. Always an ESTIMATE — never an invoice figure. */
  costEstUsd: doublePrecision("cost_est_usd"),
  /** 'estimate' when costEstUsd is set; null otherwise. */
  costSource: text("cost_source"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AiConfig = typeof aiConfigTable.$inferSelect;
export type AiUsage = typeof aiUsageTable.$inferSelect;
