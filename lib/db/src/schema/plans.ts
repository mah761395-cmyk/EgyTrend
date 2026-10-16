import { pgTable, serial, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const subscriptionPlansTable = pgTable("subscription_plans", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  nameAr: text("name_ar").notNull(),
  /** Base price outside an active timed/targeted offer. */
  price: integer("price").notNull(),
  /** Optional truthful comparison price for the base price. */
  oldPrice: integer("old_price"),
  /** none | auto | custom — resolved centrally by getEffectivePrice(). */
  priceBadgeMode: text("price_badge_mode").notNull().default("none"),
  priceBadgeText: text("price_badge_text"),
  durationMonths: integer("duration_months").notNull(),
  features: jsonb("features").$type<string[]>().default([]),
  isActive: boolean("is_active").default(true),
  /** Existing non-price plan label (for example, "الأشهر"). */
  badge: text("badge"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPlanSchema = createInsertSchema(subscriptionPlansTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPlan = z.infer<typeof insertPlanSchema>;
export type SubscriptionPlan = typeof subscriptionPlansTable.$inferSelect;
