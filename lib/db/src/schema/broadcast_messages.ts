import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { appUsersTable } from "./users";
import { employeesTable } from "./employees";

/**
 * Sanitized rich text only. Raw HTML is never stored or rendered: API input is
 * parsed from a deliberately tiny markdown subset into this structure.
 */
export type BroadcastInline = {
  text: string;
  bold?: boolean;
  /** Server-validated https URL or same-origin path. */
  link?: string;
};

export type BroadcastBlock = {
  type: "paragraph" | "bullet_list" | "ordered_list";
  inlines?: BroadcastInline[];
  items?: BroadcastInline[][];
};

export type BroadcastContent = {
  version: 1;
  blocks: BroadcastBlock[];
};

export type BroadcastAction = {
  /** Coupon variants are retained for a future redemption implementation but rejected today. */
  kind: "none" | "link" | "coupon_copy" | "coupon_apply";
  label?: string;
  url?: string;
  couponCode?: string;
};

/** Image uploads are binary-signature validated and served through a local route. */
export const broadcastMediaTable = pgTable("broadcast_media", {
  id: text("id").primaryKey(),
  mimeType: text("mime_type").notNull(),
  dataUrl: text("data_url").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdBy: integer("created_by").notNull().references(() => employeesTable.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [
  index("broadcast_media_created_idx").on(table.createdAt),
]);

export const broadcastMessagesTable = pgTable("broadcast_messages", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  content: jsonb("content").$type<BroadcastContent>().notNull(),
  /** offer | greeting | new_feature | maintenance | important */
  messageType: text("message_type").notNull(),
  /** all | guests | free | vip | expiring | new_users */
  audience: text("audience").notNull().default("all"),
  priority: integer("priority").notNull().default(0),
  /** draft | published | paused | archived. Scheduled/active/ended are derived from dates. */
  status: text("status").notNull().default("draft"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  imageMediaId: text("image_media_id").references(() => broadcastMediaTable.id, { onDelete: "set null" }),
  action: jsonb("action").$type<BroadcastAction>().notNull().default({ kind: "none" }),
  /** Optional active plan chosen by an admin for {{price}} family variables. */
  variablePlanKey: text("variable_plan_key"),
  /** Stored only as a request/confirmation record. No bulk-mail worker is enabled. */
  marketingEmailRequested: boolean("marketing_email_requested").notNull().default(false),
  marketingEmailConfirmedAt: timestamp("marketing_email_confirmed_at", { withTimezone: true }),
  createdBy: integer("created_by").notNull().references(() => employeesTable.id, { onDelete: "restrict" }),
  updatedBy: integer("updated_by").references(() => employeesTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [
  index("broadcast_messages_schedule_idx").on(table.status, table.startsAt, table.endsAt),
  index("broadcast_messages_audience_idx").on(table.audience, table.status),
  index("broadcast_messages_created_idx").on(table.createdAt),
]);

/** One durable displayed/interaction state per registered person and message. */
export const broadcastMessageUserStatesTable = pgTable("broadcast_message_user_states", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => broadcastMessagesTable.id, { onDelete: "restrict" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "restrict" }),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  doNotShowAgainAt: timestamp("do_not_show_again_at", { withTimezone: true }),
  ctaClickedAt: timestamp("cta_clicked_at", { withTimezone: true }),
  couponCopiedAt: timestamp("coupon_copied_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("broadcast_message_user_states_message_user_uidx").on(table.messageId, table.userId),
  index("broadcast_message_user_states_message_idx").on(table.messageId, table.seenAt),
  index("broadcast_message_user_states_user_idx").on(table.userId, table.seenAt),
]);

/** Audit-friendly record of an admin-only visual test; it is never a mass e-mail send. */
export const broadcastTestDeliveriesTable = pgTable("broadcast_test_deliveries", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => broadcastMessagesTable.id, { onDelete: "restrict" }),
  employeeId: integer("employee_id").notNull().references(() => employeesTable.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("broadcast_test_deliveries_message_idx").on(table.messageId, table.createdAt),
]);

export type BroadcastMedia = typeof broadcastMediaTable.$inferSelect;
export type BroadcastMessage = typeof broadcastMessagesTable.$inferSelect;
export type BroadcastMessageUserState = typeof broadcastMessageUserStatesTable.$inferSelect;
