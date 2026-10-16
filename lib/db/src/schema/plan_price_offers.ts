import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { subscriptionPlansTable } from "./plans";

/**
 * A timed or audience-specific price display for a subscription plan.
 * Rows are archived rather than deleted so pricing history remains reversible.
 * `audience` is a stable string key on purpose: new groups can be introduced
 * without a destructive enum migration. The application fails closed for an
 * unknown audience until it explicitly implements its eligibility predicate.
 */
export const planPriceOffersTable = pgTable("plan_price_offers", {
  id: text("id").primaryKey(),
  planId: integer("plan_id").notNull().references(() => subscriptionPlansTable.id, { onDelete: "restrict" }),
  audience: text("audience").notNull().default("all"),
  price: integer("price").notNull(),
  oldPrice: integer("old_price"),
  badgeMode: text("badge_mode").notNull().default("none"),
  badgeText: text("badge_text"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  showCountdown: boolean("show_countdown").notNull().default(false),
  /** Higher values win when more than one matching offer is active. */
  priority: integer("priority").notNull().default(0),
  status: text("status").notNull().default("active"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type PlanPriceOffer = typeof planPriceOffersTable.$inferSelect;
