import { eq } from "drizzle-orm";

/**
 * Admin enable/disable state for market-data providers, stored in the same
 * app_settings table the other service toggles use (trial settings, pricing
 * lock, lifecycle). The DB row holds ONLY provider ids — provider
 * credentials live exclusively in environment variables and are never read,
 * copied or referenced by this module.
 *
 * The database module is loaded lazily so pure market-data unit tests (no
 * database at all) can construct the service without a DB, and read
 * semantics are fail-open (DB error → nothing disabled): a settings outage
 * must never change live market behaviour.
 */
export const MARKET_PROVIDER_SETTINGS_KEY = "market_provider_toggles";

export type MarketProviderSettings = {
  disabled: string[];
  updatedAt?: string;
};

/* Cached once (success OR failure) so a pure unit-test environment without a
 * database never re-evaluates the whole DB module graph on every read. */
let dbModulePromise: Promise<typeof import("@workspace/db")> | null = null;
function loadDbModule(): Promise<typeof import("@workspace/db")> {
  if (!dbModulePromise) dbModulePromise = import("@workspace/db");
  return dbModulePromise;
}

export async function readMarketProviderSettings(): Promise<{ disabled: Set<string> }> {
  const { appSettingsTable, db } = await loadDbModule();
  const [row] = await db.select({ value: appSettingsTable.value })
    .from(appSettingsTable).where(eq(appSettingsTable.key, MARKET_PROVIDER_SETTINGS_KEY)).limit(1);
  if (!row?.value) return { disabled: new Set() };
  try {
    const raw = JSON.parse(row.value) as Partial<MarketProviderSettings> | null;
    const list = Array.isArray(raw?.disabled)
      ? raw?.disabled.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 80)
      : [];
    return { disabled: new Set(list) };
  } catch {
    return { disabled: new Set() };
  }
}

export async function saveMarketProviderSettings(
  disabled: ReadonlySet<string> | readonly string[],
  now: Date = new Date(),
): Promise<void> {
  const { appSettingsTable, db } = await loadDbModule();
  const value = JSON.stringify({ disabled: [...new Set(disabled)] } satisfies MarketProviderSettings);
  await db.insert(appSettingsTable).values({
    key: MARKET_PROVIDER_SETTINGS_KEY,
    value,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: appSettingsTable.key,
    set: { value, updatedAt: now },
  });
}
