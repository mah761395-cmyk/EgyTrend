import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const paymentRequestsTable = pgTable("payment_requests", {
  id: text("id").primaryKey(),
  phone: text("phone").notNull(),
  name: text("name").notNull(),
  planKey: text("plan_key").notNull(),
  payMethod: text("pay_method").notNull().default(""),
  price: integer("price").notNull().default(0),
  tx: text("tx").notNull(),
  status: text("status").notNull().default("pending"),
  notes: text("notes"),
  /* Payment proof uploaded by the user: data URL (≤ ~290KB) + original file name. */
  proofImage: text("proof_image"),
  proofName: text("proof_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  /* When an admin approved/rejected the request (pending-age + notifications). */
  decidedAt: timestamp("decided_at"),
});

export const insertPaymentRequestSchema = createInsertSchema(paymentRequestsTable).omit({ createdAt: true, updatedAt: true });
export type InsertPaymentRequest = z.infer<typeof insertPaymentRequestSchema>;
export type PaymentRequest = typeof paymentRequestsTable.$inferSelect;
