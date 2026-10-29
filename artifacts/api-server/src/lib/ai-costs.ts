import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import {
  aiUsageTable,
  appSettingsTable,
  type AiUsage,
} from "@workspace/db/schema";
import { sendMail } from "./mailer";
import { logger } from "./logger";
import { TOGGLEABLE_AI_PROVIDERS } from "./ai-provider-settings";

/**
 * AI cost metering, editable model pricing and provider budgets.
 *
 * Financial honesty contract (spec: الدقة المالية):
 *  - Every cost figure here is an ESTIMATE: provider-reported token counts
 *    × editable list prices (USD per 1M tokens). No provider billing or
 *    invoice API is integrated, so nothing in this system may be presented
 *    as an actual invoice.
 *  - Rows without token counts (legacy rows, local engine, missing upstream
 *    metadata) keep costEstUsd = NULL and are surfaced as "unmetered" —
 *    never as $0, never fabricated.
 *  - A usage row is written exactly once per external request (at
 *    reservation, under the advisory lock) and only UPDATED afterwards, so
 *    one request can never double-book; a client retry is a new request.
 *
 * Reads are fail-open and the database module loads lazily (cached), like
 * the other settings modules, so pure unit tests stay database-free.
 */

export const AI_MODEL_PRICES_KEY = "ai_model_prices";
export const AI_BUDGETS_KEY = "ai_budgets";
export const AI_BUDGET_ALERTS_KEY = "ai_budget_alerts";

export type ModelPrice = { inPerM: number; outPerM: number };

/** Published list prices (USD per 1M tokens) for the models this build can
 *  serve. They are DEFAULTS only — the admin can (and should) review them in
 *  the panel; the estimate label stays on every figure either way. */
export const DEFAULT_AI_MODEL_PRICES: Record<string, ModelPrice> = {
  "gemini-3.5-flash-lite": { inPerM: 0.1, outPerM: 0.4 },
  "gemini-3.6-flash": { inPerM: 0.3, outPerM: 2.5 },
  "claude-sonnet-4-6": { inPerM: 3.0, outPerM: 15.0 },
};

/* Sanity caps so a dashboard typo cannot authorize unbounded spend. */
const PRICE_CAP_PER_M = 1000;
const DAILY_BUDGET_CAP_USD = 10_000;
const MONTHLY_BUDGET_CAP_USD = 250_000;

let dbModulePromise: Promise<typeof import("@workspace/db")> | null = null;
function loadDbModule(): Promise<typeof import("@workspace/db")> {
  if (!dbModulePromise) dbModulePromise = import("@workspace/db");
  return dbModulePromise;
}

/* ── settings rows ─────────────────────────────────────────────────────── */

async function settingsRow(key: string): Promise<string | null> {
  const { appSettingsTable, db } = await loadDbModule();
  const [row] = await db.select({ value: appSettingsTable.value })
    .from(appSettingsTable).where(eq(appSettingsTable.key, key)).limit(1);
  return row?.value ?? null;
}

async function upsertSetting(key: string, value: string): Promise<void> {
  const { appSettingsTable, db } = await loadDbModule();
  await db.insert(appSettingsTable).values({ key, value })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value } });
}

/* ── model prices ──────────────────────────────────────────────────────── */

export async function readAiModelPrices(): Promise<Record<string, ModelPrice>> {
  const merged: Record<string, ModelPrice> = { ...DEFAULT_AI_MODEL_PRICES };
  let raw: string | null = null;
  try {
    raw = await settingsRow(AI_MODEL_PRICES_KEY);
  } catch {
    return merged;
  }
  if (raw) {
    try {
      const stored = JSON.parse(raw) as Record<string, unknown>;
      for (const [model, v] of Object.entries(stored)) {
        if (typeof model !== "string" || !model || model.length > 64) continue;
        const e = v as Partial<ModelPrice> | null;
        if (!e || typeof e !== "object") continue;
        const inPerM = Number(e.inPerM);
        const outPerM = Number(e.outPerM);
        if (!Number.isFinite(inPerM) || !Number.isFinite(outPerM)) continue;
        if (inPerM < 0 || outPerM < 0 || inPerM > PRICE_CAP_PER_M || outPerM > PRICE_CAP_PER_M) continue;
        merged[model] = { inPerM, outPerM };
      }
    } catch {
      /* malformed row → defaults */
    }
  }
  return merged;
}

export type SavePricesResult = { ok: true } | { ok: false; error: string };

export async function saveAiModelPrices(
  prices: Record<string, ModelPrice>,
): Promise<SavePricesResult> {
  const clean: Record<string, ModelPrice> = {};
  for (const [model, v] of Object.entries(prices || {})) {
    if (typeof model !== "string" || !model || model.length > 64) {
      return { ok: false, error: "اسم النموذج غير صالح" };
    }
    const inPerM = Number(v?.inPerM);
    const outPerM = Number(v?.outPerM);
    if (!Number.isFinite(inPerM) || !Number.isFinite(outPerM) || inPerM < 0 || outPerM < 0) {
      return { ok: false, error: `سعر غير صالح للنموذج ${model}` };
    }
    if (inPerM > PRICE_CAP_PER_M || outPerM > PRICE_CAP_PER_M) {
      return { ok: false, error: `سعر مرفوض للنموذج ${model} (الحد ${PRICE_CAP_PER_M}$/M)` };
    }
    clean[model] = { inPerM, outPerM };
  }
  try {
    await upsertSetting(AI_MODEL_PRICES_KEY, JSON.stringify(clean));
  } catch (e) {
    logger.warn({ err: e }, "save ai model prices failed");
    return { ok: false, error: "تعذر حفظ الأسعار" };
  }
  return { ok: true };
}

/* ── budgets ───────────────────────────────────────────────────────────── */

export type ProviderBudget = { dailyUsd: number | null; monthlyUsd: number | null };
export type AiBudgets = { autoStop: boolean; providers: Record<string, ProviderBudget> };

export function emptyAiBudgets(): AiBudgets {
  return { autoStop: false, providers: {} };
}

export async function readAiBudgets(): Promise<AiBudgets> {
  const out = emptyAiBudgets();
  let raw: string | null = null;
  try {
    raw = await settingsRow(AI_BUDGETS_KEY);
  } catch {
    return out;
  }
  if (!raw) return out;
  try {
    const stored = JSON.parse(raw) as Partial<AiBudgets> | null;
    if (!stored || typeof stored !== "object") return out;
    out.autoStop = Boolean(stored.autoStop);
    for (const id of TOGGLEABLE_AI_PROVIDERS) {
      const p = stored.providers?.[id] as Partial<ProviderBudget> | undefined;
      if (!p) continue;
      const daily = p.dailyUsd === null || p.dailyUsd === undefined ? null : Number(p.dailyUsd);
      const monthly = p.monthlyUsd === null || p.monthlyUsd === undefined ? null : Number(p.monthlyUsd);
      out.providers[id] = {
        dailyUsd: daily !== null && Number.isFinite(daily) && daily > 0 && daily <= DAILY_BUDGET_CAP_USD ? daily : null,
        monthlyUsd: monthly !== null && Number.isFinite(monthly) && monthly > 0 && monthly <= MONTHLY_BUDGET_CAP_USD ? monthly : null,
      };
    }
  } catch {
    return emptyAiBudgets();
  }
  return out;
}

export async function saveAiBudgets(budgets: AiBudgets): Promise<SavePricesResult> {
  const out = emptyAiBudgets();
  out.autoStop = Boolean(budgets?.autoStop);
  for (const id of TOGGLEABLE_AI_PROVIDERS) {
    const p = budgets?.providers?.[id];
    if (!p) continue;
    const daily = p.dailyUsd === null || p.dailyUsd === undefined ? null : Number(p.dailyUsd);
    const monthly = p.monthlyUsd === null || p.monthlyUsd === undefined ? null : Number(p.monthlyUsd);
    if (daily !== null && (!Number.isFinite(daily) || daily <= 0 || daily > DAILY_BUDGET_CAP_USD)) {
      return { ok: false, error: `ميزانية يومية غير صالحة للمزود ${id} (حد ${DAILY_BUDGET_CAP_USD} USD)` };
    }
    if (monthly !== null && (!Number.isFinite(monthly) || monthly <= 0 || monthly > MONTHLY_BUDGET_CAP_USD)) {
      return { ok: false, error: `ميزانية شهرية غير صالحة للمزود ${id} (حد ${MONTHLY_BUDGET_CAP_USD} USD)` };
    }
    out.providers[id] = {
      dailyUsd: daily,
      monthlyUsd: monthly,
    };
  }
  try {
    await upsertSetting(AI_BUDGETS_KEY, JSON.stringify(out));
  } catch (e) {
    logger.warn({ err: e }, "save ai budgets failed");
    return { ok: false, error: "تعذر حفظ الميزانيات" };
  }
  return { ok: true };
}

/* ── spend accounting ──────────────────────────────────────────────────── */

export type Executor = {
  select: typeof import("@workspace/db")["db"]["select"];
};

/** Confirmed (status='ok') estimated spend for one provider since `since`.
 *  Rows without a metered cost are simply not in the sum. */
export async function providerSpendSince(executor: Executor, provider: string, since: Date): Promise<number> {
  const row = await executor
    .select({ sum: sql<number>`coalesce(sum(${aiUsageTable.costEstUsd}), 0)` })
    .from(aiUsageTable)
    .where(
      and(
        eq(aiUsageTable.provider, provider),
        eq(aiUsageTable.status, "ok"),
        isNotNull(aiUsageTable.costEstUsd),
        gte(aiUsageTable.createdAt, since),
      ),
    );
  return Number(row?.[0]?.sum ?? 0) || 0;
}

/** Budget state for one provider: which limits exist and how far confirmed
 *  spend has progressed. Ratio > 1 means the budget is exhausted. */
export async function providerBudgetState(
  executor: Executor,
  budgets: AiBudgets,
  provider: string,
  now: Date = new Date(),
): Promise<{ dailyUsd: number | null; monthlyUsd: number | null; dailySpend: number; monthlySpend: number; dailyPct: number | null; monthlyPct: number | null; exhausted: boolean }> {
  const b = budgets.providers[provider] || {};
  const dailySince = new Date(now);
  dailySince.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [dailySpend, monthlySpend] = await Promise.all([
    providerSpendSince(executor, provider, dailySince),
    providerSpendSince(executor, provider, monthStart),
  ]);
  const dailyPct = b.dailyUsd ? dailySpend / b.dailyUsd : null;
  const monthlyPct = b.monthlyUsd ? monthlySpend / b.monthlyUsd : null;
  return {
    dailyUsd: b.dailyUsd ?? null,
    monthlyUsd: b.monthlyUsd ?? null,
    dailySpend: round4(dailySpend),
    monthlySpend: round4(monthlySpend),
    dailyPct,
    monthlyPct,
    /* Exhausted only when auto-stop is ON: with auto-stop off a budget is an
     * advisory alert, not a hard block. */
    exhausted:
      budgets.autoStop &&
      ((dailyPct !== null && dailyPct >= 1) || (monthlyPct !== null && monthlyPct >= 1)),
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Pick the serving engine under budget. Order mirrors effectiveEngine():
 *  gemini → anthropic → local. Admin-disabled providers are skipped (that
 *  state is enforced by the caller via disabledAiProviders); this adds the
 *  budget rule. Local is free — never budget-exhausted. */
export type BudgetedPick = {
  engine: "gemini" | "anthropic" | "local";
  skipped: Partial<Record<string, "budget">>;
};

export async function pickBudgetedEngine(
  executor: Executor,
  keyPresent: { gemini: boolean; anthropic: boolean },
  budgets: AiBudgets,
  now: Date = new Date(),
): Promise<BudgetedPick> {
  const skipped: Partial<Record<string, "budget">> = {};
  for (const id of ["gemini", "anthropic"] as const) {
    if (!keyPresent[id]) continue;
    const state = await providerBudgetState(executor, budgets, id, now);
    if (state.exhausted) {
      skipped[id] = "budget";
      continue;
    }
    return { engine: id, skipped };
  }
  return { engine: "local", skipped };
}

/* ── per-call cost ─────────────────────────────────────────────────────── */

/** Estimated USD for one metered call, or null when it cannot be computed
 *  (unknown model or missing token counts) — the row then stays unmetered. */
export function estimateCallCostUsd(
  model: string | null | undefined,
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
  prices: Record<string, ModelPrice>,
): number | null {
  if (!model || tokensIn == null || tokensOut == null) return null;
  const p = prices[model];
  if (!p) return null;
  const cost = (tokensIn / 1_000_000) * p.inPerM + (tokensOut / 1_000_000) * p.outPerM;
  if (!Number.isFinite(cost) || cost < 0) return null;
  return Math.round(cost * 1e8) / 1e8;
}

export type UsageRowPatch = {
  provider?: string | null;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  status?: AiUsage["status"];
  costEstUsd?: number | null;
  costSource?: string | null;
};

/** Update-in-place: the row already exists from the reservation, so a call
 *  can never be recorded twice. */
export async function updateAiUsageRow(rowId: number, patch: UsageRowPatch): Promise<void> {
  const { db } = await loadDbModule();
  const set: Record<string, unknown> = {};
  if (patch.provider !== undefined) set.provider = patch.provider;
  if (patch.model !== undefined) set.model = patch.model;
  if (patch.tokensIn !== undefined) set.tokensIn = patch.tokensIn;
  if (patch.tokensOut !== undefined) set.tokensOut = patch.tokensOut;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.costEstUsd !== undefined) set.costEstUsd = patch.costEstUsd;
  if (patch.costSource !== undefined) set.costSource = patch.costSource;
  if (!Object.keys(set).length) return;
  await db.update(aiUsageTable).set(set as never).where(eq(aiUsageTable.id, rowId));
}

/* ── budget alerts ─────────────────────────────────────────────────────── */

export type BudgetAlertEntry = {
  level: "warn" | "over";
  pct: number;
  at: string;
  lastNotifiedAt?: string;
};

export type BudgetAlerts = Record<string, BudgetAlertEntry>;

export async function readBudgetAlerts(): Promise<BudgetAlerts> {
  let raw: string | null = null;
  try {
    raw = await settingsRow(AI_BUDGET_ALERTS_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const stored = JSON.parse(raw) as Record<string, unknown>;
    const out: BudgetAlerts = {};
    for (const [k, v] of Object.entries(stored)) {
      const e = v as Partial<BudgetAlertEntry> | null;
      if (e && (e.level === "warn" || e.level === "over") && typeof e.pct === "number" && typeof e.at === "string") {
        out[k] = { level: e.level, pct: e.pct, at: e.at, lastNotifiedAt: typeof e.lastNotifiedAt === "string" ? e.lastNotifiedAt : undefined };
      }
    }
    return out;
  } catch {
    return {};
  }
}

const NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Recompute alert state from current spend. Writes state + (at most every
 *  24h per provider) emails the active super_admins. Best-effort throughout:
 *  an alert failure must never break the chat path. */
export async function refreshBudgetAlerts(executor: Executor, now: Date = new Date()): Promise<BudgetAlerts> {
  let budgets: AiBudgets;
  let prices: Record<string, ModelPrice>;
  try {
    [budgets, prices] = await Promise.all([readAiBudgets(), readAiModelPrices()]);
  } catch {
    return readBudgetAlerts().catch(() => ({}));
  }
  const previous = await readBudgetAlerts().catch(() => ({} as BudgetAlerts));
  const next: BudgetAlerts = { ...previous };

  for (const id of TOGGLEABLE_AI_PROVIDERS) {
    const state = await providerBudgetState(executor, budgets, id, now).catch(() => null);
    if (!state) continue;
    const prev = previous[id];
    const pcts = [state.dailyPct, state.monthlyPct].filter((p): p is number => p !== null);
    const maxPct = pcts.length ? Math.max(...pcts) : 0;
    if (maxPct >= 1) {
      /* Keep the previous notification stamp: the 24h cooldown must survive
       * re-evaluations, otherwise every refresh would email again. */
      next[id] = { level: "over", pct: round4(maxPct), at: now.toISOString(), lastNotifiedAt: prev?.lastNotifiedAt };
    } else if (maxPct >= 0.8) {
      next[id] = { level: "warn", pct: round4(maxPct), at: now.toISOString(), lastNotifiedAt: prev?.lastNotifiedAt };
    } else {
      delete next[id];
      continue;
    }
    const shouldNotify =
      !prev ||
      prev.level !== next[id].level ||
      (prev.level === next[id].level &&
        (!prev.lastNotifiedAt || now.getTime() - Date.parse(prev.lastNotifiedAt) >= NOTIFY_COOLDOWN_MS));
    if (shouldNotify) {
      next[id] = { ...next[id], lastNotifiedAt: now.toISOString() };
      void notifyBudgetAlert(id, next[id], state).catch((e) =>
        logger.warn({ err: e }, "budget alert notification failed"),
      );
    }
  }
  try {
    await upsertSetting(AI_BUDGET_ALERTS_KEY, JSON.stringify(next));
  } catch (e) {
    logger.warn({ err: e }, "persist budget alerts failed");
  }
  return next;
}

async function notifyBudgetAlert(
  provider: string,
  alert: BudgetAlertEntry,
  state: Awaited<ReturnType<typeof providerBudgetState>>,
): Promise<void> {
  const { db } = await loadDbModule();
  const { employeesTable } = await import("@workspace/db/schema");
  const rows = await db
    .select({ email: employeesTable.email })
    .from(employeesTable)
    .where(and(eq(employeesTable.role, "super_admin"), eq(employeesTable.status, "active")));
  const emails = rows.map((r) => r.email).filter((e): e is string => Boolean(e));
  if (!emails.length) return;
  const word = alert.level === "over" ? "تجاوزت" : "اقتربت من";
  const subject = `EgyTrend: ميزانية AI للمزود ${provider} ${word} الحد`;
  const html = `
    <div dir="rtl" style="font-family:sans-serif;color:#111;line-height:1.7">
      <h3 style="margin:0 0 8px">تنبيه ميزانية الذكاء الاصطناعي</h3>
      <p>المزود <b>${provider}</b> ${word} الميزانية (${Math.round(alert.pct * 100)}%).</p>
      <p>الإنفاق اليومي: <b>$${state.dailySpend}</b>${state.dailyUsd ? ` من $${state.dailyUsd}` : ""}<br/>
         الإنفاق الشهري: <b>$${state.monthlySpend}</b>${state.monthlyUsd ? ` من $${state.monthlyUsd}` : ""}</p>
      <p style="color:#666;font-size:12px">أرقام تقديرية محسوبة من عدادات الاستخدام والأسعار المعروضة — ليست فواتير مزود.</p>
      <p>راجع لوحة الإدارة ← إدارة AI للتفاصيل.</p>
    </div>`;
  for (const to of emails) {
    const r = await sendMail(to, subject, html);
    if (!r.delivered) logger.warn({ to: "super_admin", reason: r.error }, "budget alert email not delivered");
  }
}
