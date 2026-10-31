import { integer, pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { appUsersTable } from "./users";

/**
 * Stored-value wallet: one balance row per application user.
 *
 * Balance is an integer in EGP (the same unit as plan prices) and may never
 * go negative — the database check is the last line of defence; debits always
 * happen inside a transaction that locks the row and checks the balance
 * before subtracting. The wallet is only credited by explicit,
 * admin-approved top-up requests (payment_requests with planKey
 * "wallet_topup") — never automatically from any external payment method.
 */
export const userWalletsTable = pgTable(
  "user_wallets",
  {
    userId: integer("user_id").primaryKey().references(() => appUsersTable.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    balance: integer("balance").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
);

/**
 * Append-only financial ledger. Every wallet credit and debit posts exactly
 * one row; rows are never updated or deleted.
 *
 * The unique (ref_kind, ref_id) index is the authoritative double-operation
 * guard: a top-up request posts once, and a renewal slot debits once, even
 * under concurrent cron executions across server instances. `balanceAfter`
 * keeps the ledger self-auditable without re-deriving state.
 */
export const walletTransactionsTable = pgTable(
  "wallet_transactions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    /** "topup" | "renewal_debit" — the only two balance movements. */
    kind: text("kind").notNull(),
    /** Positive absolute amount in EGP; direction is implied by `kind`. */
    amount: integer("amount").notNull(),
    /** Balance immediately after this posting. */
    balanceAfter: integer("balance_after").notNull(),
    /** "payment_request" | "auto_renewal" */
    refKind: text("ref_kind").notNull(),
    refId: text("ref_id").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("wallet_transactions_ref_uidx").on(t.refKind, t.refId),
    index("wallet_transactions_user_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * A user's explicit auto-renewal consent and its state machine.
 *
 * A row exists only after the user explicitly opted in (at checkout with
 * `autoRenew` consent, or later from their subscription settings). Status:
 *   * active   — the scheduled debit will run when `nextRenewalAt` arrives
 *   * disabled — the user turned it off; the CURRENT paid term still runs to
 *                its stored end (disabling never cancels a paid term)
 *   * expired  — the term lapsed without a funded renewal; nothing scheduled
 *
 * `lastKnownPrice` is a display snapshot only. The actual debit amount is
 * always the plan's current server price read at renewal time.
 */
export const subscriptionRenewalsTable = pgTable(
  "subscription_renewals",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    planKey: text("plan_key").notNull(),
    planNameAr: text("plan_name_ar").notNull(),
    planDurationMonths: integer("plan_duration_months").notNull(),
    lastKnownPrice: integer("last_known_price").notNull().default(0),
    /** "active" | "disabled" | "expired" */
    status: text("status").notNull().default("active"),
    nextRenewalAt: timestamp("next_renewal_at", { withTimezone: true }),
    lastRenewedAt: timestamp("last_renewed_at", { withTimezone: true }),
    /** The wallet-ledger ref of the last successful debit. */
    lastRenewalRef: text("last_renewal_ref"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    /** "ok" | "insufficient_balance" | "plan_unavailable" | "no_active_subscription" | "expired" */
    lastAttemptResult: text("last_attempt_result"),
    consentAt: timestamp("consent_at").notNull(),
    /** "checkout" | "settings" */
    consentSource: text("consent_source").notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("subscription_renewals_user_uidx").on(t.userId)],
);

export type UserWallet = typeof userWalletsTable.$inferSelect;
export type WalletTransaction = typeof walletTransactionsTable.$inferSelect;
export type SubscriptionRenewal = typeof subscriptionRenewalsTable.$inferSelect;
