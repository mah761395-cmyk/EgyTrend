import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  appSettingsTable,
  userCalculatorActivityTable,
  userCalculatorScenariosTable,
  userFeeProfilesTable,
  type FeeProfileItem,
} from "@workspace/db/schema";
import { EGX_STOCKS } from "../lib/market-data/catalog";
import { getMarketDataService } from "../lib/market-data/service";
import { getCalculatorMathModuleSource } from "../lib/calculators/math";
import { getCalculatorRuntimeModuleSource } from "../lib/calculators/runtime";
import { currentAppOwner, requireVipFeature } from "../lib/userAuth";
import { getStocksSnapshot, type StockQuote } from "./markets";
import { logger } from "../lib/logger";

const router = Router();

const CALCULATOR_KEYS = new Set(["pl", "risk", "compound", "average", "dividend", "cagr", "inflation", "fx"]);
const ACTIVITY_ACTIONS = new Set(["saved", "copied", "exported", "calculated"]);
const ID_RX = /^[a-f0-9-]{20,80}$/i;
const SYMBOL_RX = /^[A-Z0-9._-]{1,16}$/;
const MAX_PAYLOAD_BYTES = 32_000;
const MAX_QUOTE_AGE_GRACE_MINUTES = 20;
const REALTIME_MAX_AGE_MINUTES = 5;

type SafeObject = Record<string, unknown>;

type PayloadInput = {
  calculatorKey: string;
  name?: string;
  action?: string;
  inputs: SafeObject;
  result: SafeObject;
};

function noStoreJavascript(res: Response, source: string) {
  res.status(200)
    .set("Cache-Control", "private, no-store, max-age=0")
    .set("Pragma", "no-cache")
    .set("Cross-Origin-Resource-Policy", "same-origin")
    .type("application/javascript; charset=utf-8")
    .send(source);
}

function isSafeData(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null) return depth <= 8;
  if (typeof value === "string") return value.length <= 500;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= 1_000_000_000_000_000;
  if (Array.isArray(value)) return value.length <= 1_500 && value.every((item) => isSafeData(item, depth + 1));
  if (typeof value !== "object") return false;
  const record = value as SafeObject;
  const keys = Object.keys(record);
  return keys.length <= 80
    && keys.every((key) => key.length <= 80 && key !== "__proto__" && key !== "constructor" && key !== "prototype" && isSafeData(record[key], depth + 1));
}

function payloadObject(value: unknown): SafeObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isSafeData(value)) return null;
  try {
    const copy = JSON.parse(JSON.stringify(value)) as SafeObject;
    return JSON.stringify(copy).length <= MAX_PAYLOAD_BYTES ? copy : null;
  } catch {
    return null;
  }
}

function parsePayload(raw: unknown, mode: "scenario" | "activity"): PayloadInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const calculatorKey = String(body.calculatorKey || "").trim();
  if (!CALCULATOR_KEYS.has(calculatorKey)) return null;
  const inputs = payloadObject(body.inputs);
  const result = payloadObject(body.result);
  /* The browser's pure function marks a completed calculation explicitly;
     stored scenarios are recomputed on load rather than trusted as advice. */
  if (!inputs || !result || result.ok !== true) return null;
  const parsed: PayloadInput = { calculatorKey, inputs, result };
  if (mode === "scenario") {
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    if (!name || name.length > 80) return null;
    parsed.name = name;
  } else {
    const action = String(body.action || "").trim();
    if (!ACTIVITY_ACTIONS.has(action)) return null;
    parsed.action = action;
  }
  return parsed;
}

function quoteFreshness(quote: { price?: number; source?: string; ts?: number; freshness?: string; delayedMinutes?: number }): { valid: boolean; delayed: boolean } {
  if (!Number.isFinite(quote.price) || (quote.price || 0) <= 0 || !quote.source || !Number.isFinite(quote.ts)) return { valid: false, delayed: true };
  if (quote.freshness !== "real-time" && quote.freshness !== "delayed") return { valid: false, delayed: true };
  const declaredDelay = typeof quote.delayedMinutes === "number" && quote.delayedMinutes >= 0 ? quote.delayedMinutes : 0;
  /* A quote called real-time has a narrow age window. Delayed data can still
     be useful only with its explicit delayed label and declared delay window. */
  const maxAge = quote.freshness === "real-time"
    ? REALTIME_MAX_AGE_MINUTES * 60_000
    : Math.max(MAX_QUOTE_AGE_GRACE_MINUTES, declaredDelay + MAX_QUOTE_AGE_GRACE_MINUTES) * 60_000;
  const age = Date.now() - Number(quote.ts);
  if (age < -5 * 60_000 || age > maxAge) return { valid: false, delayed: true };
  return { valid: true, delayed: quote.freshness !== "real-time" || declaredDelay > 0 };
}

function asOf(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function publicScenario(row: typeof userCalculatorScenariosTable.$inferSelect) {
  return {
    id: row.id,
    calculatorKey: row.calculatorKey,
    name: row.name,
    inputs: row.inputs,
    result: row.result,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function publicActivity(row: typeof userCalculatorActivityTable.$inferSelect) {
  return {
    id: row.id,
    calculatorKey: row.calculatorKey,
    action: row.action,
    createdAt: row.createdAt.toISOString(),
  };
}

/* The complete calculator runtime and every computational function are gated
 * independently. A copied runtime URL is therefore not an entitlement bypass. */
router.get("/calculators/bootstrap", requireVipFeature("calculators"), (_req: Request, res: Response) => {
  res.set("Cache-Control", "private, no-store, max-age=0").json({
    status: "ok",
    runtime: "/api/calculators/runtime.js",
    math: "/api/calculators/math.js",
    disclaimer: "النتائج تقديرية ولا تمثل نصيحة استثمارية.",
  });
});

router.get("/calculators/runtime.js", requireVipFeature("calculators"), (_req: Request, res: Response) => {
  noStoreJavascript(res, getCalculatorRuntimeModuleSource());
});

router.get("/calculators/math.js", requireVipFeature("calculators"), (_req: Request, res: Response) => {
  noStoreJavascript(res, getCalculatorMathModuleSource());
});

/** A quote may be used in a calculator only while its licensed source and
 * declared freshness are present. End-of-day/unknown/stale values fail closed. */
router.get("/calculators/quote", requireVipFeature("calculators"), async (req: Request, res: Response) => {
  const symbol = String(req.query["symbol"] || "").trim().toUpperCase();
  if (!SYMBOL_RX.test(symbol) || !EGX_STOCKS.some((stock) => stock.sym === symbol)) {
    res.status(400).json({ status: "error", message: "رمز سهم EGX غير مدعوم لاستخدام السعر الحالي" });
    return;
  }
  try {
    const quote = (await getStocksSnapshot())?.find((item) => item.sym.toUpperCase() === symbol) as StockQuote | undefined;
    const quality = quote ? quoteFreshness(quote) : { valid: false, delayed: true };
    if (!quote || !quality.valid) {
      res.status(503).json({ status: "unavailable", message: "السعر الحالي غير متاح حاليًا من مصدر مرخّص ومحدّث؛ أدخله يدويًا." });
      return;
    }
    res.set("Cache-Control", "no-store").json({
      status: "ok",
      quote: {
        symbol: quote.sym,
        price: quote.price,
        currency: "EGP",
        source: quote.source,
        asOf: asOf(quote.ts),
        freshness: quote.freshness,
        delayed: quality.delayed,
        delayedMinutes: quote.delayedMinutes,
      },
    });
  } catch (error) {
    logger.warn({ err: (error as Error).message, symbol }, "calculator quote unavailable");
    res.status(503).json({ status: "unavailable", message: "السعر الحالي غير متاح حاليًا؛ أدخله يدويًا." });
  }
});

/**
 * Cross rates come only from configured market-data providers. EGP=1 is a
 * unit conversion identity; every other rate must pass the same freshness
 * rules, and the response carries its actual source/as-of per currency.
 */
router.get("/calculators/fx", requireVipFeature("calculators"), async (_req: Request, res: Response) => {
  const targetInstruments = new Map([
    ["USD", "fx:USD-EGP"], ["EUR", "fx:EUR-EGP"], ["GBP", "fx:GBP-EGP"], ["SAR", "fx:SAR-EGP"],
  ]);
  try {
    const snapshot = await getMarketDataService().getBoard();
    if (snapshot.stale) {
      res.status(503).json({ status: "unavailable", available: false, message: "أسعار الصرف من المصدر متأخرة حاليًا. لم يتم تقديمها كسعر حالي." });
      return;
    }
    const quoteById = new Map(snapshot.quotes.map((quote) => [quote.instrumentId, quote]));
    const rates: Record<string, number> = { EGP: 1 };
    const rateMetadata: Record<string, { source: string; asOf: string; freshness: string; delayed: boolean; delayedMinutes?: number }> = {};
    for (const [currency, instrumentId] of targetInstruments) {
      const quote = quoteById.get(instrumentId);
      if (!quote) continue;
      const quality = quoteFreshness({ price: quote.price, source: quote.sourceName, ts: quote.asOf, freshness: quote.freshness, delayedMinutes: quote.delayedMinutes });
      if (!quality.valid) continue;
      rates[currency] = quote.price;
      rateMetadata[currency] = {
        source: quote.sourceName,
        asOf: asOf(quote.asOf),
        freshness: quote.freshness,
        delayed: quality.delayed,
        ...(typeof quote.delayedMinutes === "number" ? { delayedMinutes: quote.delayedMinutes } : {}),
      };
    }
    const values = Object.values(rateMetadata);
    if (!values.length) {
      res.status(503).json({ status: "unavailable", available: false, message: "أسعار الصرف من المصدر غير متاحة حاليًا. لم يتم استخدام سعر ثابت بديل." });
      return;
    }
    const source = [...new Set(values.map((item) => item.source))].join(" + ");
    const latest = values.map((item) => item.asOf).sort().at(-1)!;
    const delayed = values.some((item) => item.delayed);
    res.set("Cache-Control", "no-store").json({
      status: "ok", available: true, rates,
      metadata: { source, asOf: latest, delayed, rateMetadata },
    });
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "calculator FX unavailable");
    res.status(503).json({ status: "unavailable", available: false, message: "أسعار الصرف من المصدر غير متاحة حاليًا. لم يتم استخدام سعر ثابت بديل." });
  }
});

router.get("/calculators/scenarios", requireVipFeature("calculators"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const calculatorKey = String(req.query["calculator"] || "").trim();
  if (!CALCULATOR_KEYS.has(calculatorKey)) {
    res.status(400).json({ status: "error", message: "نوع الحاسبة غير صحيح" });
    return;
  }
  try {
    const rows = await db.select().from(userCalculatorScenariosTable).where(and(
      eq(userCalculatorScenariosTable.userId, user.sub),
      eq(userCalculatorScenariosTable.calculatorKey, calculatorKey),
      eq(userCalculatorScenariosTable.status, "active"),
    )).orderBy(desc(userCalculatorScenariosTable.updatedAt)).limit(50);
    res.set("Cache-Control", "private, no-store").json({ status: "ok", scenarios: rows.map(publicScenario) });
  } catch (error) {
    logger.error({ err: error, userId: user.sub }, "calculator scenarios read failed");
    res.status(503).json({ status: "error", message: "حفظ السيناريوهات غير متاح حاليًا؛ تأكد من تنفيذ ترحيل قاعدة البيانات في بيئة آمنة." });
  }
});

router.post("/calculators/scenarios", requireVipFeature("calculators"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const input = parsePayload(req.body, "scenario");
  if (!input || !input.name) {
    res.status(400).json({ status: "error", message: "اسم السيناريو وبيانات الحاسبة الصحيحة مطلوبان" });
    return;
  }
  const id = crypto.randomUUID();
  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(userCalculatorScenariosTable).values({
        id, userId: user.sub, calculatorKey: input.calculatorKey, name: input.name!, inputs: input.inputs, result: input.result,
        status: "active", createdAt: now, updatedAt: now,
      });
      await tx.insert(userCalculatorActivityTable).values({
        id: crypto.randomUUID(), userId: user.sub, calculatorKey: input.calculatorKey, action: "saved", inputs: input.inputs, result: input.result,
        status: "active", createdAt: now,
      });
    });
    res.status(201).json({ status: "ok", id });
  } catch (error) {
    logger.error({ err: error, userId: user.sub }, "calculator scenario save failed");
    res.status(503).json({ status: "error", message: "تعذر حفظ السيناريو حاليًا؛ لم نؤكد نجاح الحفظ." });
  }
});

/** Archive rather than delete a financial scenario. */
router.delete("/calculators/scenarios/:id", requireVipFeature("calculators"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const id = String(req.params["id"] || "").trim();
  if (!ID_RX.test(id)) {
    res.status(400).json({ status: "error", message: "معرّف السيناريو غير صحيح" });
    return;
  }
  try {
    const archived = await db.update(userCalculatorScenariosTable).set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(userCalculatorScenariosTable.id, id), eq(userCalculatorScenariosTable.userId, user.sub), eq(userCalculatorScenariosTable.status, "active")))
      .returning({ id: userCalculatorScenariosTable.id });
    if (!archived.length) {
      res.status(404).json({ status: "error", message: "السيناريو غير موجود" });
      return;
    }
    res.json({ status: "ok", archived: true });
  } catch (error) {
    logger.error({ err: error, userId: user.sub }, "calculator scenario archive failed");
    res.status(503).json({ status: "error", message: "تعذر أرشفة السيناريو حاليًا" });
  }
});

/* Browser-native print preserves Arabic text and lets the user choose Save as
 * PDF. This authorization/log endpoint must succeed before the protected
 * runtime writes any exportable result into the print window. */
router.post("/calculators/export", requireVipFeature("calculators"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const raw = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  const input = parsePayload({ ...raw, action: "exported" }, "activity");
  if (!input) {
    res.status(400).json({ status: "error", message: "بيانات التصدير غير صحيحة" });
    return;
  }
  try {
    await db.insert(userCalculatorActivityTable).values({
      id: crypto.randomUUID(), userId: user.sub, calculatorKey: input.calculatorKey, action: "exported",
      inputs: input.inputs, result: input.result, status: "active", createdAt: new Date(),
    });
    res.set("Cache-Control", "private, no-store").status(201).json({ status: "ok", exportAuthorized: true });
  } catch (error) {
    logger.error({ err: error, userId: user.sub }, "calculator export authorization failed");
    res.status(503).json({ status: "error", message: "تعذر التحقق من التصدير حاليًا؛ لم يتم تأكيد إنشاء PDF." });
  }
});

/* ── Fee catalog & user fee schedules ─────────────────────────────────────
 * The catalog (which fee lines exist) is admin-managed data in app_settings —
 * never hardcoded rates. Every percent/minimum value is entered by the user
 * for their own broker and stored in their own fee schedule. */
const FEE_CATALOG_SETTING_KEY = "calculator_fee_items";
const FEE_SIDES = new Set(["buy", "sell", "both"]);

async function readFeeCatalog(): Promise<{ ok: true; items: Array<{ key: string; labelAr: string }> } | { ok: false }> {
  try {
    const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, FEE_CATALOG_SETTING_KEY));
    const parsed: unknown = row ? JSON.parse(row.value) : null;
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > 50) return { ok: false };
    const items = parsed.map((item) => ({
      key: String((item as SafeObject)?.key || "").trim().slice(0, 64),
      labelAr: String((item as SafeObject)?.labelAr || "").trim().slice(0, 80),
    })).filter((item) => item.key && item.labelAr);
    return items.length ? { ok: true, items } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function parseFeeProfilePayload(raw: unknown): { name: string; items: FeeProfileItem[] } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const name = String(body.name || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 60) return null;
  const rawItems = body.items;
  if (!Array.isArray(rawItems) || rawItems.length > 50) return null;
  const items: FeeProfileItem[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as SafeObject;
    const key = String(record.key || "").trim().slice(0, 64);
    const rawSide = String(record.side || "");
    const side: FeeProfileItem["side"] | null = FEE_SIDES.has(rawSide) ? (rawSide as FeeProfileItem["side"]) : null;
    if (!key || !side) return null;
    const percentRaw = record.percent;
    const minimumRaw = record.minimum;
    const percent = percentRaw === undefined || percentRaw === null || percentRaw === "" ? 0 : Number(percentRaw);
    const minimum = minimumRaw === undefined || minimumRaw === null || minimumRaw === "" ? 0 : Number(minimumRaw);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
    if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1_000_000_000_000) return null;
    items.push({ key, labelAr: String(record.labelAr || key).slice(0, 80), side, percent, minimum });
  }
  return { name, items };
}

router.get("/calculators/fee-catalog", requireVipFeature("calculators"), async (_req: Request, res: Response) => {
  const catalog = await readFeeCatalog();
  if (!catalog.ok) {
    res.status(503).json({ status: "error", message: "قائمة بنود الرسوم غير متاحة حاليًا؛ تأكد من تنفيذ ترحيل قاعدة البيانات في بيئة آمنة." });
    return;
  }
  res.set("Cache-Control", "private, no-store").json({ status: "ok", items: catalog.items });
});

router.get("/calculators/fee-profiles", requireVipFeature("calculators"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  try {
    const rows = await db.select().from(userFeeProfilesTable).where(and(
      eq(userFeeProfilesTable.userId, user.sub),
      eq(userFeeProfilesTable.status, "active"),
    )).orderBy(desc(userFeeProfilesTable.updatedAt)).limit(50);
    res.set("Cache-Control", "private, no-store").json({
      status: "ok",
      profiles: rows.map((row) => ({
        id: row.id, name: row.name, items: row.items,
        createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    logger.error({ err: error, userId: user.sub }, "fee profiles read failed");
    res.status(503).json({ status: "error", message: "ملفات الرسوم غير متاحة حاليًا؛ تأكد من تنفيذ ترحيل قاعدة البيانات في بيئة آمنة." });
  }
});

router.post("/calculators/fee-profiles", requireVipFeature("calculators"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const parsed = parseFeeProfilePayload(req.body);
  if (!parsed) {
    res.status(400).json({ status: "error", message: "بيانات ملف الرسوم غير صحيحة" });
    return;
  }
  const now = new Date();
  try {
    /* Same name = an explicit update of that user's schedule. */
    const [row] = await db.insert(userFeeProfilesTable).values({
      id: crypto.randomUUID(), userId: user.sub, name: parsed.name, items: parsed.items,
      status: "active", createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [userFeeProfilesTable.userId, userFeeProfilesTable.name],
      set: { items: parsed.items, updatedAt: now },
    }).returning({ id: userFeeProfilesTable.id });
    res.status(201).json({ status: "ok", id: row.id });
  } catch (error) {
    logger.error({ err: error, userId: user.sub }, "fee profile save failed");
    res.status(503).json({ status: "error", message: "تعذر حفظ ملف الرسوم حاليًا؛ لم نؤكد نجاح الحفظ." });
  }
});

router.delete("/calculators/fee-profiles/:id", requireVipFeature("calculators"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const id = String(req.params["id"] || "").trim();
  if (!ID_RX.test(id)) {
    res.status(400).json({ status: "error", message: "معرّف ملف الرسوم غير صحيح" });
    return;
  }
  try {
    const rows = await db.update(userFeeProfilesTable).set({ updatedAt: new Date() })
      .where(and(eq(userFeeProfilesTable.id, id), eq(userFeeProfilesTable.userId, user.sub)))
      .returning({ id: userFeeProfilesTable.id });
    if (!rows.length) {
      res.status(404).json({ status: "error", message: "ملف الرسوم غير موجود" });
      return;
    }
    await db.delete(userFeeProfilesTable).where(eq(userFeeProfilesTable.id, id));
    res.json({ status: "ok", deleted: true });
  } catch (error) {
    logger.error({ err: error, userId: user.sub }, "fee profile delete failed");
    res.status(503).json({ status: "error", message: "تعذر حذف ملف الرسوم حاليًا" });
  }
});

router.get("/calculators/history", requireVipFeature("calculators"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  try {
    const rows = await db.select().from(userCalculatorActivityTable)
      .where(and(eq(userCalculatorActivityTable.userId, user.sub), eq(userCalculatorActivityTable.status, "active")))
      .orderBy(desc(userCalculatorActivityTable.createdAt)).limit(30);
    res.set("Cache-Control", "private, no-store").json({ status: "ok", history: rows.map(publicActivity) });
  } catch (error) {
    logger.error({ err: error, userId: user.sub }, "calculator history read failed");
    res.status(503).json({ status: "error", message: "سجل العمليات غير متاح حاليًا؛ تأكد من تنفيذ ترحيل قاعدة البيانات في بيئة آمنة." });
  }
});

router.post("/calculators/history", requireVipFeature("calculators"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const input = parsePayload(req.body, "activity");
  if (!input || !input.action) {
    res.status(400).json({ status: "error", message: "بيانات العملية غير صحيحة" });
    return;
  }
  try {
    await db.insert(userCalculatorActivityTable).values({
      id: crypto.randomUUID(), userId: user.sub, calculatorKey: input.calculatorKey, action: input.action,
      inputs: input.inputs, result: input.result, status: "active", createdAt: new Date(),
    });
    res.status(201).json({ status: "ok" });
  } catch (error) {
    logger.error({ err: error, userId: user.sub }, "calculator activity save failed");
    res.status(503).json({ status: "error", message: "تعذر حفظ سجل العملية حاليًا؛ لم نؤكد نجاح الحفظ." });
  }
});

export default router;
