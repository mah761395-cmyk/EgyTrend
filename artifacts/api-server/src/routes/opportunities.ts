import { Router, type Request } from "express";
import { db } from "@workspace/db";
import { opportunities } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import crypto from "crypto";
import { logger } from "../lib/logger";
import { currentUser, currentActiveAdmin, hasVipFeature } from "../lib/userAuth";
import { buildLocalOpportunities, type OppCandidate } from "../lib/opp-engine";
import { getMarketsSnapshot, getStocksSnapshot, type StockQuote, type MarketsPayload } from "./markets";
import { getNewsSnapshot } from "./news";
import { getMarketDataService } from "../lib/market-data/service";
import { DrizzleMarketHistoryReadRepository, type MarketHistoryReadRepository, type StoredMarketOhlc } from "../lib/market-data/history";
import { buildOppSignal, type OpportunitySignal, type OppNewsHit } from "../lib/opp-signals";
import { evaluateOppLifecycle } from "../lib/opp-lifecycle";
type StockT = OppCandidate extends never ? never : Parameters<typeof buildLocalOpportunities>[1][number];
type NewsSnap = Awaited<ReturnType<typeof getNewsSnapshot>>;

const router = Router();

/** Opportunity mutations require an active current administrator; a stale
 * JWT, static header token, or disabled employee can never publish content. */
async function isAdmin(req: Request): Promise<boolean> {
  const admin = await currentActiveAdmin(req);
  return admin?.role === "admin" || admin?.role === "super_admin";
}

async function requireAuth(req: Request, res: any, next: any): Promise<void> {
  if (!(await isAdmin(req))) {
    res.status(401).json({ status: "error", message: "unauthorized" });
    return;
  }
  next();
}

const OPP_TYPES = new Set(["stock", "bond", "crypto", "commodity", "realestate", "etf", "fund", "ipo"]);
const OPP_MARKETS = new Set(["egypt", "us", "gulf", "crypto", "global"]);
/* TASK M: signal cards move through a lifecycle (active → realized /
 * expired / cancelled). The three legacy states stay for descriptive rows. */
const OPP_STATUSES = new Set(["active", "coming", "closed", "realized", "expired", "cancelled"]);
const OPP_ID_RX = /^[a-z0-9_-]{1,50}$/i;

type OpportunityInput = {
  title?: string; summary?: string; details?: string | null; type?: string; market?: string;
  expectedReturn?: string | null; riskLevel?: number; sector?: string | null; duration?: string | null;
  deadline?: string | null; status?: string; featured?: boolean; vipOnly?: boolean;
};

function boundedText(value: unknown, max: number, required = false): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return required ? null : null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (required && !text) return undefined;
  return text ? text.slice(0, max) : null;
}

function validateOpportunityInput(body: unknown, partial = false): OpportunityInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid request body" };
  const raw = body as Record<string, unknown>;
  const title = boundedText(raw.title, 300, !partial);
  const summary = boundedText(raw.summary, 1500, !partial);
  if ((!partial && (title === undefined || title === null || summary === undefined || summary === null))
    || (partial && ((raw.title !== undefined && (title === undefined || title === null))
      || (raw.summary !== undefined && (summary === undefined || summary === null))))) {
    return { error: "title and summary are required text fields" };
  }
  const type = raw.type === undefined ? undefined : String(raw.type);
  const market = raw.market === undefined ? undefined : String(raw.market);
  const status = raw.status === undefined ? undefined : String(raw.status);
  if ((!partial && (!type || !market)) || (type !== undefined && !OPP_TYPES.has(type)) || (market !== undefined && !OPP_MARKETS.has(market))) {
    return { error: "invalid opportunity type or market" };
  }
  if (status !== undefined && !OPP_STATUSES.has(status)) return { error: "invalid opportunity status" };
  const risk = raw.riskLevel === undefined ? undefined : Number(raw.riskLevel);
  if (risk !== undefined && (!Number.isInteger(risk) || risk < 1 || risk > 5)) return { error: "riskLevel must be an integer from 1 to 5" };
  for (const key of ["featured", "vipOnly"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") return { error: `${key} must be boolean` };
  }
  const optional = (key: string, max: number): string | null | undefined => boundedText(raw[key], max);
  // expectedReturn is a legacy read field only. Accepting and silently
  // ignoring it keeps old clients from clearing historical content while
  // preventing new projected-return claims from being written.
  const fields: Array<[string, number]> = [["details", 8000], ["sector", 100], ["duration", 100], ["deadline", 100]];
  const out: OpportunityInput = {
    ...(partial ? {} : { title: title as string, summary: summary as string, type: type!, market: market! }),
    ...(partial && raw.title !== undefined ? { title: title as string } : {}),
    ...(partial && raw.summary !== undefined ? { summary: summary as string } : {}),
    ...(type !== undefined ? { type } : {}), ...(market !== undefined ? { market } : {}),
    ...(status !== undefined ? { status } : {}), ...(risk !== undefined ? { riskLevel: risk } : {}),
    ...(raw.featured !== undefined ? { featured: raw.featured as boolean } : {}),
    ...(raw.vipOnly !== undefined ? { vipOnly: raw.vipOnly as boolean } : {}),
  };
  for (const [key, max] of fields) {
    const value = optional(key, max);
    if (raw[key] !== undefined && value === undefined) return { error: `${key} must be text or null` };
    if (raw[key] !== undefined) Object.assign(out, { [key]: value });
  }
  return out;
}

/* ─── Live in-process inputs (serverless-safe) ─────────────────────────
 * Reads the SAME in-process caches the /api/markets, /api/markets/stocks
 * and /api/news routes serve. A localhost self-fetch is impossible on
 * Vercel (nothing binds a port inside a serverless function) — that is
 * exactly why generation used to fail there with a misleading 502. */
async function collectLiveInputs(): Promise<{
  markets: Record<string, unknown> | null;
  stocks: StockQuote[];
  newsTitles: string[];
}> {
  const [mk, st, news] = await Promise.allSettled([
    getMarketsSnapshot(),
    getStocksSnapshot(),
    getNewsSnapshot(),
  ]);
  const markets =
    mk.status === "fulfilled" && mk.value ? (mk.value.data as unknown as Record<string, unknown>) : null;
  const stocks = st.status === "fulfilled" && st.value ? st.value : [];
  const newsTitles: string[] = [];
  if (news.status === "fulfilled" && news.value) {
    for (const f of news.value.feeds.slice(0, 6)) {
      for (const it of (f.items || []).slice(0, 3)) newsTitles.push(it.title);
      if (newsTitles.length >= 10) break;
    }
  }
  return { markets, stocks, newsTitles };
}

/* Stable id from a title so a saved/opened opportunity keeps working across
 * reloads even when it is served live (not persisted). */
function stableOppId(title: string): string {
  return "loc-" + crypto.createHash("md5").update(title).digest("hex").slice(0, 10);
}

/* ─── TASK M (M4): structured signal cards + lifecycle ──────────────
 * Signal cards are built ONLY from the persisted daily OHLC store plus one
 * verified live quote. An empty or lagging store means no signal — the
 * engine fails closed and the legacy descriptive path keeps working. ─── */

/* Test seam (mirrors setMarketDataServiceForTest): the real reader's ranked
 * query uses a window function that pg-mem cannot execute, so tests swap in
 * a plain equivalent. Production always uses the real repository. */
let historyReader: MarketHistoryReadRepository = new DrizzleMarketHistoryReadRepository();
export function setOpportunityHistoryReaderForTest(reader: MarketHistoryReadRepository | null): void {
  historyReader = reader ?? new DrizzleMarketHistoryReadRepository();
}

function cairoDay(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

function parseSignal(raw: unknown): OpportunitySignal | null {
  if (!raw) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== "object") return null;
  const s = obj as OpportunitySignal;
  if (
    typeof s.signalType !== "string" ||
    typeof s.stopLoss !== "number" ||
    !s.targets || typeof s.targets.t1 !== "number" || typeof s.targets.t2 !== "number" ||
    !s.entry || typeof s.entry.low !== "number" || typeof s.entry.high !== "number"
  ) {
    return null;
  }
  return s;
}

function buildCardDetails(s: OpportunitySignal): string {
  const src = (d: { name: string; asOf: number; basis: string }) => {
    const basis = d.basis === "fetch" ? "وقت الجلب" : d.basis === "history" ? "سجل التداول" : "وقت المصدر";
    return `• ${d.name} — ${new Date(d.asOf).toUTCString()} (${basis})`;
  };
  return [
    `النوع: ${s.signalTypeAr} — القوة: ${s.strength}/100 (${s.strengthLabelAr})`,
    `السبب: ${s.reasonAr}`,
    "",
    "العوامل:",
    ...s.factors.map((f) => `• ${f.labelAr} (${f.points > 0 ? "+" : ""}${f.points})`),
    "",
    `منطقة الدخول: ${s.entry.low} – ${s.entry.high} — ${s.entry.noteAr}`,
    `وقف الخسارة: ${s.stopLoss}`,
    `الهدف الأول: ${s.targets.t1} — الهدف الثاني: ${s.targets.t2}`,
    `نسبة العائد للمخاطرة: ${s.rewardRisk} — الأفق: ${s.timeframeAr}`,
    "",
    `السيناريو الإيجابي: ${s.scenarioPositiveAr}`,
    `السيناريو السلبي: ${s.scenarioNegativeAr}`,
    "",
    "المصادر:",
    ...s.dataSources.map(src),
    "",
    "تنبيه: هذه قراءة تحليلية مشروطة بالمستويات الموضحة — ليست توصية استثمارية ولا ضمانًا لأي ربح.",
  ].join("\n");
}

/* Deterministic keyword sentiment for headlines that name the instrument.
 * A headline is only "positive"/"negative" when exactly one polarity is
 * present — otherwise it stays neutral and never touches the score. The
 * card always names the source and the title, so the judgment is verifiable. */
const NEWS_POSITIVE_RX = /(ربح|أرباح|تجاوز|نمو|صعود|زيادة|قفزة|توسع|رقم قياسي|record|growth|surge|profit|gain|upgrade|beat)/i;
const NEWS_NEGATIVE_RX = /(خسائر|خسارة|تراجع|انخفاض|هبوط|تحذير|تجميد|تسريح|تراجع|loss|decline|drop|warning|downgrade|miss|layoff)/i;

function newsHitsFor(symbol: string, name: string, news: NewsSnap | null, now: number): OppNewsHit[] {
  if (!news) return [];
  const hits: OppNewsHit[] = [];
  const symU = symbol.toUpperCase();
  const nameU = name.toUpperCase();
  for (const feed of news.feeds) {
    const feedName = (feed as { meta?: { name?: string } }).meta?.name || "مصدر الأخبار";
    for (const item of feed.items) {
      const when = item.pubDate ? Date.parse(item.pubDate) : NaN;
      if (!Number.isFinite(when) || now - when > 24 * 3_600_000) continue;
      const text = `${item.title} ${item.description || ""}`;
      const upper = text.toUpperCase();
      const namesIt = (symU.length >= 2 && upper.includes(symU)) || (nameU.length >= 4 && upper.includes(nameU));
      if (!namesIt) continue;
      const pos = NEWS_POSITIVE_RX.test(text);
      const neg = NEWS_NEGATIVE_RX.test(text);
      const impact: OppNewsHit["impact"] = pos && !neg ? "positive" : neg && !pos ? "negative" : "neutral";
      if (impact === "neutral") continue;
      hits.push({ title: item.title, sourceName: feedName, publishedAt: when, link: item.link, impact });
      if (hits.length >= 3) return hits;
    }
  }
  return hits;
}

type LiveCandidate = {
  instrumentId: string;
  symbol: string;
  name: string;
  currency?: string;
  price: number;
  asOf: number;
  timeBasis: "source" | "fetch";
  state: "live" | "closed" | "stale";
  sourceName: string;
  changePercent?: number;
};

/**
 * Live candidates = one numeric price per instrument, joined with the
 * session state the board UI already shows. FX reference rows are excluded:
 * a daily reference rate is not signal material. Stale rows stay in the list
 * (with state "stale") so the pipeline can count and report them.
 */
async function collectCandidates(): Promise<{ candidates: LiveCandidate[]; quoteMap: Map<string, LiveCandidate> }> {
  const [boardSnap, boardCan, stocks] = await Promise.allSettled([
    getMarketsSnapshot(),
    getMarketDataService().getBoard(),
    getStocksSnapshot(),
  ]);
  const candidates: LiveCandidate[] = [];
  const quoteMap = new Map<string, LiveCandidate>();
  const add = (c: LiveCandidate): void => {
    candidates.push(c);
    quoteMap.set(c.instrumentId, c);
  };
  if (boardSnap.status === "fulfilled" && boardCan.status === "fulfilled" && boardSnap.value.data) {
    const data = boardSnap.value.data as MarketsPayload;
    const numeric = new Map(boardCan.value.quotes.map((q) => [q.instrumentId, q]));
    const sections = [data.markets.eg, data.markets.gl, data.markets.cm, data.markets.cr];
    for (const rows of sections) {
      for (const row of rows || []) {
        if (!row.id || row.id.startsWith("fx:")) continue;
        const num = numeric.get(row.id);
        if (!num || !Number.isFinite(num.price) || num.price <= 0) continue;
        add({
          instrumentId: row.id,
          /* Canonical symbol = the id suffix (EGX30, BTC, XAUUSD, …) — it is
           * what headlines actually contain, unlike the display subtitle. */
          symbol: row.id.split(":").pop() || row.id,
          name: row.n,
          currency: num.currency,
          price: num.price,
          asOf: row.asOf ?? num.asOf,
          timeBasis: row.timeBasis === "fetch" ? "fetch" : "source",
          state: row.state === "stale" ? "stale" : row.state === "closed" ? "closed" : "live",
          sourceName: row.source || num.sourceName,
          ...(typeof num.changePercent === "number" ? { changePercent: num.changePercent } : {}),
        });
      }
    }
  }
  if (stocks.status === "fulfilled" && stocks.value) {
    for (const s of stocks.value) {
      if (s.noData || s.price === undefined) continue;
      const price = Number(s.price);
      if (!Number.isFinite(price) || price <= 0 || !s.ts) continue;
      add({
        instrumentId: s.instrumentId,
        symbol: s.sym,
        name: s.name,
        currency: "EGP",
        price,
        asOf: s.ts,
        timeBasis: "source",
        state: s.state === "stale" ? "stale" : s.state === "closed" ? "closed" : "live",
        sourceName: s.source || "EGX licensed scanner",
        ...(typeof s.chgPct === "number" && Number.isFinite(s.chgPct) ? { changePercent: s.chgPct } : {}),
      });
    }
  }
  return { candidates, quoteMap };
}

/**
 * Read-only live status for active signal cards on GET: the persisted status
 * is authoritative; this only tells the UI what the current verified price
 * says right now. No writes here — persistence happens on the next
 * generate/cron cycle.
 */
async function enrichWithLiveUpdates(rows: any[]): Promise<void> {
  const targets = rows.filter((r) => r.status === "active" && r.instrumentId && r.signal);
  if (!targets.length) return;
  let quoteMap: Map<string, LiveCandidate>;
  try {
    ({ quoteMap } = await collectCandidates());
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "opportunities live update skipped — snapshot unavailable");
    return;
  }
  const now = Date.now();
  for (const row of targets) {
    const sig = parseSignal(row.signal);
    if (!sig) continue;
    const cand = quoteMap.get(String(row.instrumentId));
    const price = cand && cand.state !== "stale" ? cand.price : null;
    const verdict = evaluateOppLifecycle(sig, price, now, new Date(row.createdAt).getTime());
    row.liveUpdate = {
      statusNow: verdict.status,
      noteAr: verdict.noteAr,
      price,
      priceAsOf: cand ? cand.asOf : null,
      priceTimeBasis: cand ? cand.timeBasis : null,
    };
  }
}

type GenerationSummary = {
  inserted: number;
  signals: number;
  descriptive: number;
  closedLegacy: number;
  lifecycle: { realized: number; expired: number };
  skipped: { noHistory: number; noSignal: number; duplicate: number; noQuote: number };
  noteAr: string;
};

async function runGenerationPipeline(): Promise<GenerationSummary> {
  const now = Date.now();
  const summary: GenerationSummary = {
    inserted: 0,
    signals: 0,
    descriptive: 0,
    closedLegacy: 0,
    lifecycle: { realized: 0, expired: 0 },
    skipped: { noHistory: 0, noSignal: 0, duplicate: 0, noQuote: 0 },
    noteAr: "",
  };
  const day = cairoDay(now);
  const { candidates, quoteMap } = await collectCandidates();
  const [news] = await Promise.allSettled([getNewsSnapshot()]);

  const existing = await db.select().from(opportunities);

  /* 1) Lifecycle of existing active signal cards — verified prices only. */
  const activeSignalRows = existing.filter((o) => o.status === "active" && o.instrumentId && o.signal);
  const stillActive = new Set<string>();
  for (const row of activeSignalRows) {
    const sig = parseSignal(row.signal);
    if (!sig) continue;
    const cand = quoteMap.get(String(row.instrumentId));
    const verdict = evaluateOppLifecycle(sig, cand && cand.state !== "stale" ? cand.price : null, now, new Date(row.createdAt).getTime());
    if (verdict.status !== "active") {
      await db.update(opportunities)
        .set({ status: verdict.status, result: verdict.result, realizedAt: new Date(verdict.realizedAt ?? now), updatedAt: new Date() })
        .where(eq(opportunities.id, row.id));
      if (verdict.status === "realized") summary.lifecycle.realized += 1;
      else summary.lifecycle.expired += 1;
    } else {
      stillActive.add(row.id);
    }
  }

  /* 2) Dedupe: one active signal per instrument+type+Cairo day. */
  const taken = new Set<string>();
  for (const row of activeSignalRows) {
    if (!stillActive.has(row.id)) continue;
    const sig = parseSignal(row.signal);
    if (sig) taken.add(`${String(row.instrumentId)}:${sig.signalType}:${day}`);
  }

  /* 3) Signal engine over candidates that have verified history. */
  const histable = candidates.filter((c) => c.state !== "stale");
  const from = new Date(now - 40 * 86_400_000).toISOString().slice(0, 10);
  let history: StoredMarketOhlc[] = [];
  try {
    history = await historyReader.list(histable.map((c) => c.instrumentId), from);
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "opportunities history read failed — no signals this cycle");
  }
  /* Stored bars are redisplayed only while their source still carries an
   * explicit active customer-display approval — the same gate the history
   * endpoint applies. A lapsed right does not keep generating signals. */
  const service = getMarketDataService();
  const historyCapable = service.historySourceIds();
  const allowedSources = new Set(
    service.descriptors()
      .filter((d) => d.state === "configured" && d.externalDisplayConfirmed && historyCapable.has(d.id))
      .map((d) => d.id),
  );
  const byInstrument = new Map<string, StoredMarketOhlc[]>();
  const sourceNameByInstrument = new Map<string, string>();
  for (const h of history) {
    if (!allowedSources.has(h.sourceId)) continue;
    const arr = byInstrument.get(h.instrumentId) ?? [];
    arr.push(h);
    byInstrument.set(h.instrumentId, arr);
    sourceNameByInstrument.set(h.instrumentId, h.sourceName);
  }

  const newSignalRows: Array<typeof opportunities.$inferInsert> = [];
  for (const cand of candidates) {
    if (cand.state === "stale") {
      summary.skipped.noQuote += 1;
      continue;
    }
    const rows = byInstrument.get(cand.instrumentId);
    if (!rows || !rows.length) {
      summary.skipped.noHistory += 1;
      continue;
    }
    const historyAsOf = Math.max(...rows.map((r) => r.asOf.getTime()));
    const signal = buildOppSignal({
      bars: rows.map((r) => ({
        tradingDate: r.tradingDate,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        ...(r.volume !== null && r.volume !== undefined ? { volume: r.volume } : {}),
      })),
      quote: {
        instrumentId: cand.instrumentId,
        symbol: cand.symbol,
        name: cand.name,
        ...(cand.currency ? { currency: cand.currency } : {}),
        price: cand.price,
        ...(cand.changePercent !== undefined ? { changePercent: cand.changePercent } : {}),
        asOf: cand.asOf,
        timeBasis: cand.timeBasis,
        state: cand.state,
        sourceName: cand.sourceName,
      },
      historySource: sourceNameByInstrument.get(cand.instrumentId) ?? "سجل التداول اليومي",
      historyAsOf,
      newsHits: newsHitsFor(cand.symbol, cand.name, news.status === "fulfilled" ? news.value : null, now),
      cairoDay: day,
      now,
    });
    if (!signal) {
      summary.skipped.noSignal += 1;
      continue;
    }
    if (taken.has(signal.dedupeKey)) {
      summary.skipped.duplicate += 1;
      continue;
    }
    taken.add(signal.dedupeKey);
    newSignalRows.push({
      id: crypto.randomUUID().slice(0, 12),
      title: `${cand.name} — ${signal.signalTypeAr}`,
      summary: signal.reasonAr,
      details: buildCardDetails(signal),
      type: signal.assetType,
      market: signal.market,
      /* No projected return: the engine states levels and conditions only. */
      expectedReturn: null,
      riskLevel: signal.strength >= 70 ? 2 : signal.strength >= 40 ? 3 : 4,
      sector: `[SIGNAL] ${signal.signalType}`,
      duration: signal.timeframeAr,
      deadline: null,
      status: "active",
      featured: false,
      vipOnly: true,
      instrumentId: signal.instrumentId,
      signal,
      firstPrice: cand.price,
    });
  }

  /* 4) The descriptive fallback is computed BEFORE the transaction: closing
   * the superseded descriptive cards only happens when we actually replace
   * them with something — never leave the page empty. */
  let descriptiveRows: Array<typeof opportunities.$inferInsert> = [];
  if (!newSignalRows.length) {
    const { markets, stocks: stockRows, newsTitles } = await collectLiveInputs();
    const list = stockRows.length
      ? buildLocalOpportunities(markets, stockRows as StockT[], newsTitles, new Date(now).toLocaleDateString("ar-EG", { weekday: "long", year: "numeric", month: "long", day: "numeric" }))
      : [];
    descriptiveRows = list.map((opportunity) => ({
      id: crypto.randomUUID().slice(0, 12),
      title: opportunity.title,
      summary: opportunity.summary,
      details: opportunity.details,
      type: opportunity.type,
      market: opportunity.market,
      /* No projected return: the verified feeds do not supply a defensible
       * projection, so emitting one would be fabricated. */
      expectedReturn: null,
      riskLevel: opportunity.riskLevel,
      sector: `[AUTO] ${opportunity.sector}`,
      duration: opportunity.duration,
      deadline: null,
      status: "active",
      featured: opportunity.featured,
      vipOnly: opportunity.vipOnly,
    }));
    if (list.length) {
      summary.noteAr = "لم يتكوّن سجل تداول كافٍ بعد لتوليد إشارات — عُرضت الملاحظات الوصفية الموثقة من نفس المصادر حتى يتوفر السجل.";
    } else {
      summary.noteAr = "لا توجد بيانات سوق موثقة كافية حاليًا — لم يُنشأ شيء.";
    }
  }

  const legacyIds = existing
    .filter((o) => /^\[(?:AI|AUTO)\]/.test(o.sector || "") && o.status === "active")
    .map((o) => o.id);

  await db.transaction(async (tx) => {
    if (newSignalRows.length || descriptiveRows.length) {
      for (const id of legacyIds) {
        await tx.update(opportunities).set({ status: "closed", updatedAt: new Date() }).where(eq(opportunities.id, id));
      }
      for (const row of [...newSignalRows, ...descriptiveRows]) {
        await tx.insert(opportunities).values(row);
      }
    }
  });

  summary.signals = newSignalRows.length;
  summary.descriptive = descriptiveRows.length;
  summary.closedLegacy = (newSignalRows.length || descriptiveRows.length) ? legacyIds.length : 0;
  summary.inserted = summary.signals + summary.descriptive;
  if (newSignalRows.length) {
    summary.noteAr = "تم توليد بطاقات إشارات مبنية على سجل التداول الموثق والأسعار الحية الموثقة.";
  }
  return summary;
}

/* Source-backed observation rows. Shared by GET fallback, /generate and
 * /seed so each path presents the same descriptive cards without rankings. */
async function buildLiveOpportunityRows(): Promise<Array<Record<string, unknown>>> {
  const { markets, stocks, newsTitles } = await collectLiveInputs();
  if (!stocks.length) return [];
  const today = new Date().toLocaleDateString("ar-EG", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const candidates = buildLocalOpportunities(markets, stocks as any, newsTitles, today);
  const now = new Date().toISOString();
  return candidates.map((c) => ({
    id: stableOppId(c.title),
    title: c.title, summary: c.summary, details: c.details,
    type: c.type, market: c.market, expectedReturn: c.expectedReturn,
    riskLevel: c.riskLevel, sector: c.sector, duration: c.duration,
    deadline: null, status: "active", featured: c.featured, vipOnly: c.vipOnly,
    createdAt: now, updatedAt: now, source: c.source, sourceAsOf: c.sourceAsOf, autoObservation: true,
  }));
}

/* ─── GET /api/opportunities ─────────────────────────────────── */
router.get("/opportunities", async (req, res) => {
  const admin = await isAdmin(req);
  let vip = false;
  try { vip = await hasVipFeature(currentUser(req), "opportunities"); } catch { /* treat as non-vip */ }
  /* TASK M: signal cards additionally expose their structured payload and a
   * live status update. The VIP mask hides ALL of that plus the details —
   * levels and factors are the paid content, not just prose. */
  const mask = (o: any) => (admin || vip || !o.vipOnly ? o : { ...o, details: null, signal: null, liveUpdate: null });

  try {
    const all = await db.select().from(opportunities).orderBy(desc(opportunities.createdAt));
    const visible = admin ? all : all.filter(o => o.status !== "deleted" && o.status !== "closed");
    if (visible.length) {
      await enrichWithLiveUpdates(visible as any[]);
      return res.json({ status: "ok", opportunities: visible.map(mask), source: "db" });
    }
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "opportunities DB read failed — using live fallback");
  }

  /* DB empty or unavailable → serve live data-backed opportunities so the
   * VIP tab is never dead (read-only, not persisted). */
  try {
    const live = await buildLiveOpportunityRows();
    return res.json({ status: "ok", opportunities: live.map(mask), source: "live" });
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "live opportunities fallback failed");
    return res.json({ status: "ok", opportunities: [], source: "none",
      note: "تعذر تحميل الفرص حاليًا — أعد المحاولة بعد لحظات." });
  }
});

/* ─── POST /api/opportunities ────────────────────────────────── */
router.post("/opportunities", requireAuth, async (req, res) => {
  const input = validateOpportunityInput(req.body);
  if ("error" in input) return res.status(400).json({ status: "error", message: input.error });
  try {
    const id = crypto.randomUUID().slice(0, 12);
    await db.insert(opportunities).values({
      id,
      title: input.title!,
      summary: input.summary!,
      details: input.details ?? null,
      type: input.type!,
      market: input.market!,
      // Projected return is deprecated: never create a new value for it.
      expectedReturn: null,
      riskLevel: input.riskLevel ?? 3,
      sector: input.sector ?? null,
      duration: input.duration ?? null,
      deadline: input.deadline ?? null,
      status: input.status ?? "active",
      featured: input.featured ?? false,
      vipOnly: input.vipOnly ?? false,
    });
    return res.json({ status: "ok", id });
  } catch (e) {
    logger.error({ err: e }, "opportunity create failed");
    return res.status(500).json({ status: "error", message: "Failed to create opportunity" });
  }
});

/* ─── PUT /api/opportunities/:id ─────────────────────────────── */
router.put("/opportunities/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!OPP_ID_RX.test(id)) return res.status(400).json({ status: "error", message: "invalid opportunity id" });
  const input = validateOpportunityInput(req.body, true);
  if ("error" in input) return res.status(400).json({ status: "error", message: input.error });
  if (!Object.keys(input).length) return res.status(400).json({ status: "error", message: "no update fields supplied" });
  try {
    await db.update(opportunities)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(opportunities.id, id));
    return res.json({ status: "ok" });
  } catch (e) {
    logger.error({ err: e }, "opportunity update failed");
    return res.status(500).json({ status: "error", message: "Failed to update opportunity" });
  }
});

/* ─── DELETE /api/opportunities/:id ─────────────────────────── */
/* Compatibility endpoint: archive/close instead of destructive deletion so
 * administrative history remains recoverable. Existing clients may retain the
 * DELETE verb, but it never removes a financial-content record. */
router.delete("/opportunities/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!OPP_ID_RX.test(id)) return res.status(400).json({ status: "error", message: "invalid opportunity id" });
  try {
    await db.update(opportunities)
      .set({ status: "closed", updatedAt: new Date() })
      .where(eq(opportunities.id, id));
    return res.json({ status: "ok", archived: true });
  } catch (e) {
    logger.error({ err: e }, "opportunity archive failed");
    return res.status(500).json({ status: "error", message: "Failed to archive opportunity" });
  }
});

/* ─── POST /api/opportunities/generate ───────────────────────
   TASK M: admin-only generation. Order of work:
   1) lifecycle transitions for existing signal cards (verified prices only),
   2) new signals from the persisted OHLC store + verified live quotes
      (deduped per instrument+type+Cairo day, fail-closed on empty history),
   3) the legacy descriptive cards only as a fallback while the history
      store has not accumulated enough bars yet.
   It never asks a language model to invent an opportunity or target return.
   ─────────────────────────────────────────────────────────── */
router.post("/opportunities/generate", requireAuth, async (_req, res) => {
  try {
    const summary = await runGenerationPipeline();
    logger.info({ ...summary }, "opportunity generation cycle finished");
    return res.json({ status: "ok", ...summary });
  } catch (error) {
    // Do not return generated rows as a successful result when durable storage
    // failed. The admin can safely retry without assuming they were published.
    logger.error({ err: error }, "opportunity generation failed");
    return res.status(503).json({
      status: "error",
      message: "تعذّر حفظ الفرص بشكل دائم — لم يتم تطبيق أي تغيير.",
    });
  }
});

/* ─── /api/opportunities/cron ────────────────────────────────
   Scheduled generation cycle (Vercel cron, after the EGX close).
   Authorization mirrors the markets/backups crons: the shared cron secret
   (x-cron-secret / Bearer, timing-safe) or the vercel-cron platform markers
   (Vercel's scheduler issues a plain GET and cannot attach custom headers).
   Unauthorized requests get a 404 — the endpoint's existence is not
   advertised. The job is idempotent: dedupe + lifecycle guards make
   overlapping cycles safe. */
function cronAuthorized(req: Request): boolean {
  const secret = (process.env["MARKET_SNAPSHOT_CRON_SECRET"] || "").trim();
  if (!secret) return false;
  const supplied = String(req.get("x-cron-secret") || req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(secret);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function vercelCronAuthorized(req: Request): boolean {
  const userAgent = String(req.get("user-agent") || "").toLowerCase();
  const schedule = String(req.get("x-vercel-cron-schedule") || "").trim();
  return userAgent.startsWith("vercel-cron") && schedule.length > 0;
}

async function runCronJob(req: Request, res: any): Promise<void> {
  try {
    const summary = await runGenerationPipeline();
    logger.info({ ...summary, trigger: "cron" }, "opportunity cron cycle finished");
    res.json({ status: "ok", ...summary });
  } catch (error) {
    logger.error({ err: error }, "opportunity cron job failed");
    res.status(500).json({ status: "error", message: "generation_failed" });
  }
}

router.get("/opportunities/cron", (req: Request, res: any) => {
  if (!vercelCronAuthorized(req)) {
    res.status(404).json({ status: "error", message: "not found" });
    return;
  }
  void runCronJob(req, res);
});

router.post("/opportunities/cron", (req: Request, res: any) => {
  if (!cronAuthorized(req)) {
    res.status(404).json({ status: "error", message: "not found" });
    return;
  }
  void runCronJob(req, res);
});

/* ─── POST /api/opportunities/seed ───────────────────────────
   Persists source-backed descriptive cards from the configured market layer.
   Fields unavailable upstream remain omitted; no values are invented.
   Admin-only. */
router.post("/opportunities/seed", requireAuth, async (req, res) => {
  const { force } = req.body || {};
  try {
    const existing = await db.select().from(opportunities);
    if (existing.length > 0 && !force) {
      return res.json({ status: "skipped", reason: "already seeded", count: existing.length });
    }
    const rows = await buildLiveOpportunityRows();
    if (!rows.length) {
      return res.status(502).json({ status: "error", message: "لا توجد بيانات سوق كافية حاليًا" });
    }
    await db.transaction(async (tx) => {
      for (const r of rows) {
        await tx.insert(opportunities).values({
          id: String(r.id),
          title: String(r.title),
          summary: String(r.summary),
          details: (r.details as string) || null,
          type: String(r.type),
          market: String(r.market),
          expectedReturn: null,
          riskLevel: Number(r.riskLevel) || 3,
          sector: `[AUTO] ${String(r.sector || "")}`,
          duration: (r.duration as string) || null,
          deadline: null,
          status: "active",
          featured: Boolean(r.featured),
          vipOnly: Boolean(r.vipOnly),
        });
      }
    });
    return res.json({ status: "ok", inserted: rows.length, source: "live" });
  } catch (e: unknown) {
    logger.error({ err: e }, "seed opportunities error");
    return res.status(503).json({ status: "error", message: "تعذّر حفظ الفرص بشكل دائم — لم يتم تطبيق أي تغيير" });
  }
});

export default router;
