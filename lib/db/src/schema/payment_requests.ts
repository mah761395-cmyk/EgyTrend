import { pgTable, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const paymentRequestsTable = pgTable("payment_requests", {
  id: text("id").primaryKey(),
  phone: text("phone").notNull(),
  name: text("name").notNull(),
  planKey: text("plan_key").notNull(),
  payMethod: text("pay_method").notNull().default(""),
  /** The server-calculated amount charged for this request; never client input. */
  price: integer("price").notNull().default(0),
  /** Immutable server-side calculation and plan details at request creation. */
  priceSnapshot: jsonb("price_snapshot").$type<Record<string, unknown>>(),
  /** The snapshot is valid for a configurable limited window (24h by default). */
  priceLockedUntil: timestamp("price_locked_until", { withTimezone: true }),
  tx: text("tx").notNull(),
  status: text("status").notNull().default("pending"),
  notes: text("notes"),
  /* Payment proof uploaded by the user: data URL (≤ ~290KB) + original file name. */
  proofImage: text("proof_image"),
  proofName: text("proof_name"),
  /** Optional, normalized sender number is used only as a review signal for
   * referral fraud—not as a reason to auto-reject a payment or account. */
  senderPhone: text("sender_phone"),
  /** SHA-256 of the supplied proof; raw proof remains in the payment record. */
  proofHash: text("proof_hash"),
  referralRewardId: text("referral_reward_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  /* When an admin approved/rejected the request (pending-age + notifications). */
  decidedAt: timestamp("decided_at"),
});

export const insertPaymentRequestSchema = createInsertSchema(paymentRequestsTable).omit({ createdAt: true, updatedAt: true });
export type InsertPaymentRequest = z.infer<typeof insertPaymentRequestSchema>;
export type PaymentRequest = typeof paymentRequestsTable.$inferSelect;
