import { Router } from "express";
import { db } from "@workspace/db";
import { opportunities } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { logger } from "../lib/logger";
import { adminToken, currentUser, isVipActive } from "../lib/userAuth";
import { buildLocalOpportunities, type OppCandidate } from "../lib/opp-engine";
import { getMarketsSnapshot, getStocksSnapshot, type StockQuote } from "./markets";
import { getNewsSnapshot } from "./news";
type StockT = OppCandidate extends never ? never : Parameters<typeof buildLocalOpportunities>[1][number];

const router = Router();

const JWT_SECRET = process.env["SESSION_SECRET"];
/* Roles allowed to mutate opportunities. The old static ADMIN_TOKEN backdoor
 * (a non-expiring shared string that granted admin) was removed — only a
 * signed staff JWT from the httpOnly admin session cookie is accepted. */
const OPP_ADMIN_ROLES = new Set(["super_admin", "admin"]);

const ANTHROPIC_BASE =
  process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"] || "https://api.anthropic.com";
const ANTHROPIC_KEY =
  process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"] ||
  process.env["ANTHROPIC_API_KEY"] ||
  "";
const AI_MODEL       = "claude-sonnet-4-6";

function isAdmin(req: any): boolean {
  const token = adminToken(req);
  if (!token || !JWT_SECRET) return false;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || typeof payload === "string") return false;
    const role = (payload as { role?: string }).role;
    return !!role && OPP_ADMIN_ROLES.has(role);
  } catch {
    return false;
  }
}

/* 401 when there is no session at all, 403 when there is one but the role is
 * not allowed — so a free/regular user can never reach admin mutations. */
function requireAuth(req: any, res: any, next: any) {
  if (!adminToken(req)) return res.status(401).json({ status: "error", message: "unauthorized" });
  if (!isAdmin(req)) return res.status(403).json({ status: "error", message: "insufficient permissions" });
  next();
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

/* Data-backed opportunity rows (never fake). Shared by the GET fallback,
 * /generate and /seed so every path shows the SAME real picks. */
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
    createdAt: now, updatedAt: now, source: "live",
  }));
}

/* ─── GET /api/opportunities ─────────────────────────────────── */
router.get("/opportunities", async (req, res) => {
  const admin = isAdmin(req);
  let vip = false;
  try { vip = await isVipActive(currentUser(req)); } catch { /* treat as non-vip */ }
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
  try {
    const { title, summary, details, type, market, expectedReturn, riskLevel, sector, duration, deadline, status, featured, vipOnly } = req.body;
    if (!title || !summary || !type || !market) {
      return res.status(400).json({ status: "error", message: "title, summary, type, market required" });
    }
    const id = crypto.randomUUID().slice(0, 12);
    await db.insert(opportunities).values({
      id,
      title,
      summary,
      details: details || null,
      type,
      market,
      expectedReturn: expectedReturn || null,
      riskLevel: riskLevel ?? 3,
      sector: sector || null,
      duration: duration || null,
      deadline: deadline || null,
      status: status || "active",
      featured: featured ?? false,
      vipOnly: vipOnly ?? false,
    });
    return res.json({ status: "ok", id });
  } catch (e) {
    return res.status(500).json({ status: "error", message: "Failed to create opportunity" });
  }
});

/* ─── PUT /api/opportunities/:id ─────────────────────────────── */
router.put("/opportunities/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, summary, details, type, market, expectedReturn, riskLevel, sector, duration, deadline, status, featured, vipOnly } = req.body;
    await db.update(opportunities)
      .set({
        ...(title !== undefined && { title }),
        ...(summary !== undefined && { summary }),
        ...(details !== undefined && { details }),
        ...(type !== undefined && { type }),
        ...(market !== undefined && { market }),
        ...(expectedReturn !== undefined && { expectedReturn }),
        ...(riskLevel !== undefined && { riskLevel }),
        ...(sector !== undefined && { sector }),
        ...(duration !== undefined && { duration }),
        ...(deadline !== undefined && { deadline }),
        ...(status !== undefined && { status }),
        ...(featured !== undefined && { featured }),
        ...(vipOnly !== undefined && { vipOnly }),
        updatedAt: new Date(),
      })
      .where(eq(opportunities.id, id));
    return res.json({ status: "ok" });
  } catch (e) {
    return res.status(500).json({ status: "error", message: "Failed to update opportunity" });
  }
});

/* ─── DELETE /api/opportunities/:id ─────────────────────────── */
router.delete("/opportunities/:id", requireAuth, async (req, res) => {
  try {
    await db.delete(opportunities).where(eq(opportunities.id, req.params.id));
    return res.json({ status: "ok" });
  } catch (e) {
    return res.status(500).json({ status: "error", message: "Failed to delete opportunity" });
  }
});

/* ─── POST /api/opportunities/generate ───────────────────────
   AI-powered: reads real market data → asks Claude → inserts fresh opportunities.
   Admin-only. Replaces AI-generated ones so they stay current.
   ─────────────────────────────────────────────────────────── */
router.post("/opportunities/generate", requireAuth, async (req, res) => {
  /* No Anthropic key → local rule-based engine over REAL live data
   * (markets + stocks + news). Same contract, zero fake data. */
  if (!ANTHROPIC_BASE || !ANTHROPIC_KEY) {
    try {
      /* In-process snapshots — serverless-safe (no localhost self-fetch). */
      const { markets: mkData, stocks: allStocks, newsTitles } = await collectLiveInputs();
      const list = buildLocalOpportunities(mkData, allStocks as StockT[], newsTitles,
        new Date().toLocaleDateString("ar-EG", { weekday: "long", year: "numeric", month: "long", day: "numeric" }));
      if (!list.length) {
        return res.status(502).json({ status: "error", message: "لا توجد بيانات سوق كافية حاليًا — أعد المحاولة بعد التحديث" });
      }
      /* Persist best-effort: if the DB is unavailable we STILL return the
       * freshly-built rows so the admin gets a result instead of a 500. */
      const rows = list.map((opp) => ({ id: crypto.randomUUID().slice(0, 12), ...opp }));
      try {
        const now = new Date();
        const existingAll = await db.select().from(opportunities);
        const aiGenIds = existingAll.filter(o => o.sector?.startsWith("[AI]")).map(o => o.id);
        for (const id of aiGenIds) {
          await db.update(opportunities).set({ status: "closed", updatedAt: now }).where(eq(opportunities.id, id));
        }
        for (const opp of list) {
          await db.insert(opportunities).values({
            id: crypto.randomUUID().slice(0, 12),
            title: opp.title, summary: opp.summary, details: opp.details,
            type: opp.type, market: opp.market,
            expectedReturn: opp.expectedReturn, riskLevel: opp.riskLevel,
            sector: `[AI] ${opp.sector}`, duration: opp.duration,
            deadline: null, status: "active",
            featured: opp.featured, vipOnly: opp.vipOnly,
          });
        }
        logger.info({ inserted: list.length, closedOld: aiGenIds.length, engine: "local" }, "opportunities generated");
        return res.json({ status: "ok", inserted: list.length, closedOld: aiGenIds.length, engine: "local" });
      } catch (e) {
        logger.warn({ err: (e as Error)?.message }, "opportunities persist failed — returning live rows");
        return res.json({ status: "ok", inserted: 0, persisted: false, engine: "local", opportunities: rows });
      }
    } catch (e) {
      logger.warn({ err: e }, "local opportunity generation failed");
      return res.status(500).json({ status: "error", message: "تعذر التوليد — أعد المحاولة" });
    }
  }
  try {
    // Live data read IN-PROCESS (serverless-safe — no localhost self-fetch).
    const liveInput = await collectLiveInputs();
    const mkData = liveInput.markets || {};
    const newsData: { feeds?: Array<{ items?: Array<{ title?: string }> }> } =
      { feeds: [{ items: liveInput.newsTitles.map((t) => ({ title: t })) }] };

    const mkSummary = JSON.stringify(mkData).slice(0, 3000);
    /* /api/news returns { feeds: [{ items: [...] }] } — flatten titles from
     * every feed (previously read a non-existent "articles" key → empty list). */
    const newsSummary = (newsData.feeds || [])
      .flatMap(f => f.items || [])
      .slice(0, 15)
      .map(a => `• ${a.title || ""}`)
      .filter(Boolean)
      .join("\n");

    const today = new Date().toLocaleDateString("ar-EG", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

    const prompt = `أنت محلل مالي متخصص بالأسواق المصرية والعالمية. اليوم ${today}.

بيانات السوق الحالية (JSON):
${mkSummary}

أبرز الأخبار المالية اليوم:
${newsSummary || "لا توجد أخبار"}

مطلوب: ولّد 8 فرص استثمارية حقيقية ومتنوعة مناسبة للمستثمر المصري الآن.
التنوع المطلوب: أسهم مصرية (2)، كريبتو (1)، ذهب أو سلع (1)، أذون خزانة أو سندات (1)، عقارات (1)، ETF أو صناديق (1)، سوق خليجي أو أمريكي (1).

أعد JSON فقط بدون أي نص إضافي — array من 8 objects، كل object يحتوي:
{
  "title": "عنوان قصير وجذاب بالعربي",
  "summary": "جملتان تشرحان الفرصة والسبب وراءها بناءً على السوق الحالي (بالعربي)",
  "details": "فقرة تفصيلية: نقاط القوة، المخاطر، وكيف يستفيد المستثمر (بالعربي، 3-4 جمل)",
  "type": "stock|ipo|realestate|fund|etf|bond|crypto|commodity",
  "market": "egypt|us|gulf|crypto|global",
  "expectedReturn": "مثال: 18-25% سنوياً",
  "riskLevel": 1-5,
  "sector": "اسم القطاع",
  "duration": "مثال: 3-6 أشهر",
  "featured": true|false,
  "vipOnly": true|false
}

قواعد:
- اجعل العوائد واقعية بناءً على البيانات المتاحة، لا مبالغة
- 2 فرص على الأقل vipOnly: true (التفاصيل الحصرية)
- 1-2 فرص featured: true (الأبرز اليوم)
- استند إلى الأرقام الحقيقية من بيانات السوق
- أسهم EGX: اذكر رمز السهم في العنوان`;

    const aiRes = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!aiRes.ok) {
      const err = await aiRes.text();
      logger.warn({ err }, "AI generation failed");
      return res.status(502).json({ status: "error", message: "AI request failed" });
    }

    const aiData: any = await aiRes.json();
    const rawText: string = aiData?.content?.[0]?.text || "[]";

    // Extract JSON array from response
    const match = rawText.match(/\[[\s\S]*\]/);
    if (!match) return res.status(502).json({ status: "error", message: "AI returned invalid JSON" });

    const oppList: any[] = JSON.parse(match[0]);
    if (!Array.isArray(oppList) || oppList.length === 0) {
      return res.status(502).json({ status: "error", message: "AI returned empty list" });
    }

    // Delete previous AI-generated opportunities (those with source="ai")
    // We tag them via sector prefixed "AI:" — instead just insert new, mark old closed
    // Strategy: insert all new ones; close old AI-generated ones (sector starts with "[AI]")
    const existingAll = await db.select().from(opportunities);
    const aiGenIds = existingAll
      .filter(o => o.sector?.startsWith("[AI]"))
      .map(o => o.id);

    for (const id of aiGenIds) {
      await db.update(opportunities)
        .set({ status: "closed", updatedAt: new Date() })
        .where(eq(opportunities.id, id));
    }

    // Insert new ones
    let inserted = 0;
    for (const opp of oppList) {
      if (!opp.title || !opp.summary || !opp.type || !opp.market) continue;
      const id = crypto.randomUUID().slice(0, 12);
      await db.insert(opportunities).values({
        id,
        title: opp.title,
        summary: opp.summary,
        details: opp.details || null,
        type: opp.type,
        market: opp.market,
        expectedReturn: opp.expectedReturn || null,
        riskLevel: Math.min(5, Math.max(1, Number(opp.riskLevel) || 3)),
        sector: `[AI] ${opp.sector || ""}`,
        duration: opp.duration || null,
        deadline: null,
        status: "active",
        featured: opp.featured ?? false,
         vipOnly: Boolean(opp.vipOnly),
      });
      inserted++;
    }

    logger.info({ inserted }, "AI opportunities generated");
    return res.json({ status: "ok", inserted, closedOld: aiGenIds.length });
  } catch (e: any) {
    logger.error({ err: e?.message }, "generate opportunities error");
    return res.status(500).json({ status: "error", message: e?.message || "Failed" });
  }
});

/* ─── POST /api/opportunities/seed ───────────────────────────
   Seeds opportunities from the LIVE data engine (real market data).
   No hardcoded numbers — fields the upstream data does not provide are
   omitted rather than invented. Admin-only. */
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
    let inserted = 0;
    for (const r of rows) {
      await db.insert(opportunities).values({
        id: String(r.id),
        title: String(r.title),
        summary: String(r.summary),
        details: (r.details as string) || null,
        type: String(r.type),
        market: String(r.market),
        expectedReturn: (r.expectedReturn as string) || null,
        riskLevel: Number(r.riskLevel) || 3,
        sector: String(r.sector || ""),
        duration: (r.duration as string) || null,
        deadline: null,
        status: "active",
        featured: Boolean(r.featured),
        vipOnly: Boolean(r.vipOnly),
      });
      inserted++;
    }
    return res.json({ status: "ok", inserted, source: "live" });
  } catch (e: any) {
    logger.error({ err: e?.message }, "seed opportunities error");
    return res.status(500).json({ status: "error", message: e?.message || "Failed" });
  }
});

export default router;
