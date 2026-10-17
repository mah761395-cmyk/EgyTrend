import { eq } from "drizzle-orm";
import { appSettingsTable, db } from "@workspace/db";

export const FREE_TRIAL_SETTINGS_KEY = "free_vip_trial_v1";
export const TRIAL_FEATURE_KEYS = [
  "portfolio",
  "price_alerts",
  "calculators",
  "ai",
  "opportunities",
  "indicators",
] as const;
export type TrialFeatureKey = typeof TRIAL_FEATURE_KEYS[number];
export type TrialFeatureScope = "all" | TrialFeatureKey[];
export type TrialStartMode = "manual" | "after_email_verification";

export type FreeTrialSettings = {
  enabled: boolean;
  durationDays: number;
  startMode: TrialStartMode;
  featureScope: TrialFeatureScope;
  aiDailyLimit: number;
  /** Shared N for `trial_expired_recently` price/broadcast targeting. */
  recentlyExpiredAudienceDays: number;
};

/** Disabled by default so deploying a migration never creates a promotion
 * without an operator consciously enabling it. The editable sequence itself
 * is seeded lazily and can be reviewed while disabled. */
export const DEFAULT_FREE_TRIAL_SETTINGS: FreeTrialSettings = {
  enabled: false,
  durationDays: 7,
  startMode: "manual",
  featureScope: "all",
  aiDailyLimit: 5,
  recentlyExpiredAudienceDays: 7,
};

function featureScope(value: unknown, strict = false): TrialFeatureScope | null {
  if (value === "all") return "all";
  if (!Array.isArray(value)) return strict ? null : DEFAULT_FREE_TRIAL_SETTINGS.featureScope;
  const unique = [...new Set(value.map((entry) => String(entry || "").trim()))];
  if (unique.some((entry) => !(TRIAL_FEATURE_KEYS as readonly string[]).includes(entry))) return strict ? null : DEFAULT_FREE_TRIAL_SETTINGS.featureScope;
  return unique as TrialFeatureKey[];
}

function numberWithin(value: unknown, min: number, max: number, fallback: number, strict = false): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return strict ? null : fallback;
  return n;
}

function normalize(value: unknown, strict = false): FreeTrialSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return strict ? null : { ...DEFAULT_FREE_TRIAL_SETTINGS };
  const raw = value as Record<string, unknown>;
  if (strict && typeof raw.enabled !== "boolean") return null;
  const enabled = raw.enabled === true;
  const durationDays = numberWithin(raw.durationDays, 1, 31, DEFAULT_FREE_TRIAL_SETTINGS.durationDays, strict);
  const startMode = raw.startMode === "manual" || raw.startMode === "after_email_verification"
    ? raw.startMode : strict ? null : DEFAULT_FREE_TRIAL_SETTINGS.startMode;
  const scope = featureScope(raw.featureScope, strict);
  const aiDailyLimit = numberWithin(raw.aiDailyLimit, 0, 100, DEFAULT_FREE_TRIAL_SETTINGS.aiDailyLimit, strict);
  const recentlyExpiredAudienceDays = numberWithin(raw.recentlyExpiredAudienceDays, 1, 90, DEFAULT_FREE_TRIAL_SETTINGS.recentlyExpiredAudienceDays, strict);
  if (durationDays === null || startMode === null || scope === null || aiDailyLimit === null || recentlyExpiredAudienceDays === null) return null;
  return { enabled, durationDays, startMode, featureScope: scope, aiDailyLimit, recentlyExpiredAudienceDays };
}

export function validateFreeTrialSettings(value: unknown): FreeTrialSettings | null {
  return normalize(value, true);
}

export async function readFreeTrialSettings(): Promise<FreeTrialSettings> {
  const [row] = await db.select({ value: appSettingsTable.value }).from(appSettingsTable)
    .where(eq(appSettingsTable.key, FREE_TRIAL_SETTINGS_KEY)).limit(1);
  if (!row?.value) return { ...DEFAULT_FREE_TRIAL_SETTINGS };
  try { return normalize(JSON.parse(row.value)) || { ...DEFAULT_FREE_TRIAL_SETTINGS }; }
  catch { return { ...DEFAULT_FREE_TRIAL_SETTINGS }; }
}

export async function saveFreeTrialSettings(settings: FreeTrialSettings, now = new Date()): Promise<void> {
  await db.insert(appSettingsTable).values({
    key: FREE_TRIAL_SETTINGS_KEY,
    value: JSON.stringify(settings),
    updatedAt: now,
  }).onConflictDoUpdate({
    target: appSettingsTable.key,
    set: { value: JSON.stringify(settings), updatedAt: now },
  });
}

export function scopeAllows(scope: unknown, feature: string): boolean {
  if (scope === "all") return true;
  return Array.isArray(scope) && scope.includes(feature as TrialFeatureKey);
}
