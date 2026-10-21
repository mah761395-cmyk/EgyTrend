import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { appUsersTable } from "./users";

/**
 * Per-account progress for the introductory experience. These fields are
 * product-navigation state only: they never grant access, change a plan, or
 * stand in for server-side entitlement checks.
 */
export const userOnboardingTable = pgTable("user_onboarding", {
  userId: integer("user_id").primaryKey().references(() => appUsersTable.id, { onDelete: "cascade" }),
  /** Bump when a materially new guided tour is intentionally introduced. */
  tourVersion: integer("tour_version").notNull().default(1),
  /** new | completed | skipped; validated by the API, not the browser. */
  tourStatus: text("tour_status").notNull().default("new"),
  tourStartedAt: timestamp("tour_started_at", { withTimezone: true }),
  tourCompletedAt: timestamp("tour_completed_at", { withTimezone: true }),
  tourSkippedAt: timestamp("tour_skipped_at", { withTimezone: true }),
  /** Browser-local watchlist remains a UI preference; only a capped progress
   * counter is retained here so the onboarding card follows the account. */
  watchlistCount: integer("watchlist_count").notNull().default(0),
  watchlistCompletedAt: timestamp("watchlist_completed_at", { withTimezone: true }),
  notificationsEnabledAt: timestamp("notifications_enabled_at", { withTimezone: true }),
  newsExploredAt: timestamp("news_explored_at", { withTimezone: true }),
  /* ── VIP tour: shown once when an account first holds an active VIP
   * entitlement. 0 means the current VIP tour was never acknowledged, so the
   * account sees it on the next VIP-active state; acking stores the version. */
  vipTourVersion: integer("vip_tour_version").notNull().default(0),
  /** new | completed | skipped; validated by the API, not the browser. */
  vipTourStatus: text("vip_tour_status").notNull().default("new"),
  vipTourStartedAt: timestamp("vip_tour_started_at", { withTimezone: true }),
  vipTourCompletedAt: timestamp("vip_tour_completed_at", { withTimezone: true }),
  vipTourSkippedAt: timestamp("vip_tour_skipped_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserOnboarding = typeof userOnboardingTable.$inferSelect;
