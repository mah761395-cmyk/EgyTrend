import { pgTable, serial, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  actorId: integer("actor_id"),
  actorName: text("actor_name"),
  actorRole: text("actor_role"),
  target: text("target"),
  detail: jsonb("detail").$type<Record<string, unknown>>().default({}),
  ip: text("ip"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AuditLog = typeof auditLogsTable.$inferSelect;
