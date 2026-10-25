import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const couponsTable = pgTable("coupons", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  discountType: text("discount_type").notNull().default("percent"),
  discountValue: integer("discount_value").notNull(),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").default(0),
  isActive: boolean("is_active").default(true),
  startsAt: timestamp("starts_at"),
  expiresAt: timestamp("expires_at"),
  createdBy: integer("created_by"),
  /** Referral-created coupons are never supplied by a browser; the payment
   * service resolves them against the authenticated account automatically. */
  ownerUserId: integer("owner_user_id"),
  referralRewardId: text("referral_reward_id"),
  firstSubscriptionOnly: boolean("first_subscription_only").notNull().default(false),
  renewalOnly: boolean("renewal_only").notNull().default(false),
  autoApply: boolean("auto_apply").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCouponSchema = createInsertSchema(couponsTable).omit({ id: true, usedCount: true, createdAt: true });
export type InsertCoupon = z.infer<typeof insertCouponSchema>;
export type Coupon = typeof couponsTable.$inferSelect;
