import { eq } from "drizzle-orm";

/**
 * Admin enable/disable state for external AI providers (Gemini / Anthropic),
 * persisted in app_settings alongside the other service toggles. The row
 * holds provider ids only — API keys live exclusively in environment
 * variables and are never read, copied or referenced here.
 *
 * The local rule-based engine is NOT in this list: it is the final safety
 * net and can never be disabled, so disabling every external provider
 * degrades the assistant honestly instead of taking the site down.
 *
 * Reads are fail-open (DB error → nothing disabled) and the database module
 * is loaded lazily (cached once) so pure unit tests without a database are
 * unaffected.
 */
export const AI_PROVIDER_SETTINGS_KEY = "ai_provider_toggles";
export const AI_PROVIDER_LAST_TEST_KEY = "ai_provider_last_test";

export const TOGGLEABLE_AI_PROVIDERS = ["gemini", "anthropic"] as const;
export type ToggleableAiProviderId = (typeof TOGGLEABLE_AI_PROVIDERS)[number];

export function isToggleableAiProviderId(value: string): value is ToggleableAiProviderId {
  return (TOGGLEABLE_AI_PROVIDERS as readonly string[]).includes(value);
}

export type AiProviderId = "gemini" | "anthropic" | "local";

export type AiLastTest = {
  ok: boolean;
  at: string;
  error?: string;
  latencyMs?: number;
};

let dbModulePromise: Promise<typeof import("@workspace/db")> | null = null;
function loadDbModule(): Promise<typeof import("@workspace/db")> {
  if (!dbModulePromise) dbModulePromise = import("@workspace/db");
  return dbModulePromise;
}

export async function readAiProviderToggles(): Promise<{ disabled: Set<string> }> {
  const { appSettingsTable, db } = await loadDbModule();
  const [row] = await db.select({ value: appSettingsTable.value })
    .from(appSettingsTable).where(eq(appSettingsTable.key, AI_PROVIDER_SETTINGS_KEY)).limit(1);
  if (!row?.value) return { disabled: new Set() };
  try {
    const raw = JSON.parse(row.value) as { disabled?: unknown } | null;
    const list = Array.isArray(raw?.disabled)
      ? (raw?.disabled as unknown[]).filter(
          (x): x is string =>
            typeof x === "string" && (TOGGLEABLE_AI_PROVIDERS as readonly string[]).includes(x),
        )
      : [];
    return { disabled: new Set(list) };
  } catch {
    return { disabled: new Set() };
  }
}

export async function saveAiProviderToggles(disabled: ReadonlySet<string> | readonly string[]): Promise<void> {
  const { appSettingsTable, db } = await loadDbModule();
  const ids = disabled instanceof Set ? [...disabled] : [...disabled];
  const value = JSON.stringify({
    disabled: (TOGGLEABLE_AI_PROVIDERS as readonly string[]).filter((id) => ids.includes(id)),
  });
  await db.insert(appSettingsTable).values({
    key: AI_PROVIDER_SETTINGS_KEY,
    value,
  }).onConflictDoUpdate({
    target: appSettingsTable.key,
    set: { value },
  });
}

export async function readAiProviderLastTests(): Promise<Record<string, AiLastTest>> {
  const { appSettingsTable, db } = await loadDbModule();
  const [row] = await db.select({ value: appSettingsTable.value })
    .from(appSettingsTable).where(eq(appSettingsTable.key, AI_PROVIDER_LAST_TEST_KEY)).limit(1);
  if (!row?.value) return {};
  try {
    const raw = JSON.parse(row.value) as Record<string, unknown> | null;
    const out: Record<string, AiLastTest> = {};
    for (const id of TOGGLEABLE_AI_PROVIDERS) {
      const entry = raw?.[id] as Record<string, unknown> | undefined;
      if (entry && typeof entry.ok === "boolean" && typeof entry.at === "string") {
        out[id] = {
          ok: entry.ok,
          at: entry.at,
          error: typeof entry.error === "string" ? entry.error.slice(0, 300) : undefined,
          latencyMs: typeof entry.latencyMs === "number" && Number.isFinite(entry.latencyMs) ? entry.latencyMs : undefined,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Best-effort: a failed write must never break the probe itself. */
export async function saveAiProviderLastTest(id: AiProviderId, test: AiLastTest): Promise<void> {
  if (id === "local") return;
  try {
    const { appSettingsTable, db } = await loadDbModule();
    const current = await readAiProviderLastTests();
    const next = { ...current, [id]: test };
    const value = JSON.stringify(next);
    await db.insert(appSettingsTable).values({
      key: AI_PROVIDER_LAST_TEST_KEY,
      value,
    }).onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value },
    });
  } catch {
    /* ignore — the probe result is already in the response */
  }
}
