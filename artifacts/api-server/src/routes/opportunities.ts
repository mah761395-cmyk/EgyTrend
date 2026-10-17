import { Router, type Request } from "express";
import { db } from "@workspace/db";
import { opportunities } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { logger } from "../lib/logger";
import { ADMIN_SESSION_COOKIE, currentUser, hasVipFeature, readSessionCookie } from "../lib/userAuth";
import { buildLocalOpportunities, type OppCandidate } from "../lib/opp-engine";
import { getMarketsSnapshot, getStocksSnapshot, type StockQuote } from "./markets";
import { getNewsSnapshot } from "./news";
type StockT = OppCandidate extends never ? never : Parameters<typeof buildLocalOpportunities>[1][number];

const router = Router();

const JWT_SECRET = process.env["SESSION_SECRET"];
const LEGACY_TOKEN = process.env["ADMIN_TOKEN"] || "";

function isAdmin(req: Request): boolean {
  const token = readSessionCookie(req, ADMIN_SESSION_COOKIE)
    || (req.header("x-admin-token") || "").trim()
    || (req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  if (LEGACY_TOKEN && token === LEGACY_TOKEN) return true;
  if (!JWT_SECRET) return false;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { role?: string };
    return payload.role === "admin" || payload.role === "super_admin";
  } catch {
    return false;
  }
}

function requireAuth(req: any, res: any, next: any) {
  if (!isAdmin(req)) return res.status(401).json({ status: "error", message: "unauthorized" });
  next();
}

const OPP_TYPES = new Set(["stock", "bond", "crypto", "commodity", "realestate", "etf", "fund", "ipo"]);
const OPP_MARKETS = new Set(["egypt", "us", "gulf", "crypto", "global"]);
const OPP_STATUSES = new Set(["active", "coming", "closed"]);
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
  const admin = isAdmin(req);
  let vip = false;
  try { vip = await hasVipFeature(currentUser(req), "opportunities"); } catch { /* treat as non-vip */ }
  const mask = (o: any) => (admin || vip || !o.vipOnly ? o : { ...o, details: null });

  try {
    const all = await db.select().from(opportunities).orderBy(desc(opportunities.createdAt));
    const visible = admin ? all : all.filter(o => o.status !== "deleted" && o.status !== "closed");
    if (visible.length) {
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
   Admin-only, deterministic generation from verified licensed snapshots.
   It never asks a language model to invent an opportunity or target return.
   ─────────────────────────────────────────────────────────── */
router.post("/opportunities/generate", requireAuth, async (_req, res) => {
  try {
    /* In-process snapshots — serverless-safe and sourced only from the
     * licensed market layer. Empty data is a blocker, not an invitation for
     * an AI model to fill gaps. */
    const { markets, stocks, newsTitles } = await collectLiveInputs();
    if (!stocks.length) {
      return res.status(503).json({
        status: "error",
        message: "لا توجد بيانات أسهم موثقة كافية حاليًا — لم يتم إنشاء بطاقات وصفية.",
      });
    }
    const list = buildLocalOpportunities(
      markets,
      stocks as StockT[],
      newsTitles,
      new Date().toLocaleDateString("ar-EG", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      }),
    );
    if (!list.length) {
      return res.status(503).json({
        status: "error",
        message: "لا توجد لقطة قابلة للتحقق من البيانات الحالية — لم يتم إنشاء بطاقات وصفية.",
      });
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      const existing = await tx.select().from(opportunities);
      const generatedIds = existing
        .filter((opportunity) => /^\[(?:AI|AUTO)\]/.test(opportunity.sector || ""))
        .map((opportunity) => opportunity.id);
      for (const id of generatedIds) {
        await tx.update(opportunities)
          .set({ status: "closed", updatedAt: now })
          .where(eq(opportunities.id, id));
      }
      for (const opportunity of list) {
        await tx.insert(opportunities).values({
          id: crypto.randomUUID().slice(0, 12),
          title: opportunity.title,
          summary: opportunity.summary,
          details: opportunity.details,
          type: opportunity.type,
          market: opportunity.market,
          // No target-return field: the verified feeds do not supply a
          // defensible projection, so emitting one would be fabricated.
          expectedReturn: null,
          riskLevel: opportunity.riskLevel,
          sector: `[AUTO] ${opportunity.sector}`,
          duration: opportunity.duration,
          deadline: null,
          status: "active",
          featured: opportunity.featured,
          vipOnly: opportunity.vipOnly,
        });
      }
    });
    logger.info({ inserted: list.length, engine: "deterministic" }, "market observation cards generated");
    return res.json({ status: "ok", inserted: list.length, engine: "deterministic" });
  } catch (error) {
    // Do not return generated rows as a successful result when durable storage
    // failed. The admin can safely retry without assuming they were published.
    logger.error({ err: error }, "deterministic opportunity generation failed");
    return res.status(503).json({
      status: "error",
      message: "تعذّر حفظ الفرص بشكل دائم — لم يتم تطبيق أي تغيير.",
    });
  }
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
