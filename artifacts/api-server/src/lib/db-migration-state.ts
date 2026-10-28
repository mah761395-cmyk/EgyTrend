/**
 * Boot migration reporting state.
 *
 * Kept free of SQL imports on purpose: routes (and tests) can read the latest
 * migration outcome without pulling the inlined migration SQL into their graph.
 */

export type DriftedObject = { kind: "table" | "column" | "index"; object: string };

export type AppliedMigration = {
  id: string;
  appliedAt: string;
  appliedBy: string;
  backupSchema: string | null;
  /** Objects this migration had to create, captured immediately before it ran. */
  missingBefore: DriftedObject[];
};

export type MigrationReport = {
  /** True when every reviewed migration is recorded in the ledger. */
  ready: boolean;
  /** False when DB_AUTO_MIGRATE=off: nothing is applied, only reported. */
  autoApply: boolean;
  /** Empty when the schema is already current. */
  pending: string[];
  applied: AppliedMigration[];
  failed: { id: string; code: string; message: string }[];
  /** Snapshot schema taken before the most recent automatic migration. */
  backupSchema: string | null;
  checkedAt: string | null;
  error: string | null;
  /** True when the report was read from the ledger on demand (not at boot). */
  live?: boolean;
};

/** Reviewed migration order — mirrored by lib/db/migrations/*.up.sql. */
export const MIGRATION_IDS: readonly string[] = [
  "0001_market_daily_ohlc",
  "0002_user_subscriptions",
  "0003_portfolio_positions",
  "0004_user_price_alerts",
  "0005_subscription_plan_pricing",
  "0006_user_calculator_scenarios",
  "0007_subscription_lifecycle",
  "0008_admin_broadcasts",
  "0009_free_vip_trial",
  "0010_referral_program",
  "0011_user_onboarding",
  "0012_payment_tx_idempotency",
  "0013_vip_onboarding_tour",
  "0014_auth_hardening",
  "0015_user_fee_profiles",
  "0017_data_quality_events",
  "0018_user_onboarding_tour_replayed",
];

/** Set once the boot runner has checked the database. */
let latest: MigrationReport | null = null;

export function setMigrationReport(report: MigrationReport): void {
  latest = report;
}

/** Latest boot migration outcome (null before the first boot check finished). */
export function currentMigrationReport(): MigrationReport | null {
  if (!latest) return null;
  return {
    ...latest,
    applied: latest.applied.map((row) => ({ ...row, missingBefore: [...row.missingBefore] })),
    pending: [...latest.pending],
    failed: [...latest.failed],
  };
}

export function emptyMigrationReport(): MigrationReport {
  return {
    ready: false,
    autoApply: autoMigrateEnabled(),
    pending: [],
    applied: [],
    failed: [],
    backupSchema: null,
    checkedAt: null,
    error: null,
    live: false,
  };
}

/**
 * Automatic application is on by default: a deployment must never serve code
 * whose required columns do not exist (that is exactly how /api/user/login
 * returned HTTP 500). `DB_AUTO_MIGRATE=off` turns the runner into a read-only
 * reporter for an operator who wants to apply migrations by hand first.
 */
export function autoMigrateEnabled(): boolean {
  const value = String(process.env["DB_AUTO_MIGRATE"] ?? "on").trim().toLowerCase();
  return value !== "off" && value !== "false" && value !== "0";
}
