import { pgTable, serial, boolean, integer, timestamp, text } from "drizzle-orm/pg-core";

export const dbBackupsTable = pgTable("db_backups", {
  id: serial("id").primaryKey(),
  schemaName: text("schema_name").notNull(),
  tableCount: integer("table_count").notNull().default(0),
  /** 'manual' (admin-triggered) | 'cron' (scheduled) | 'pre_migration'. */
  kind: text("kind").notNull().default("manual"),
  createdBy: text("created_by"),
  /** True only after the post-copy row-count verification passed. A backup
   *  that was never verified is never reported as the last successful one. */
  verified: boolean("verified").notNull().default(false),
  /** Verification details (e.g. mismatched tables) — never user data. */
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type DbBackup = typeof dbBackupsTable.$inferSelect;
