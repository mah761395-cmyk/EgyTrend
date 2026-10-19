import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import { currentUser, isAdminToken, isVipActive } from "../lib/userAuth";
import { db } from "@workspace/db";
import { aiConfigTable, aiUsageTable } from "@workspace/db";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  runEngine,
  prepareMessages,
  remember,
  engineName,
  activeModel,
  geminiKey,
  anthropicKey,
  geminiVerify,
  UpstreamError,
  type ChatMsg,
  type GeminiVerify,
} from "../lib/ai-engine";
import { localAiChat } from "../lib/local-ai";
import type { PortItem, AlertItem } from "../lib/ai-tools";

const router: IRouter = Router();

/* Per-IP rate limit: 60 calls/min is generous for real usage */
const RATE: Map<string, { ts: number; count: number }> = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cur = RATE.get(ip);
  if (!cur || now - cur.ts > RATE_WINDOW_MS) {
    RATE.set(ip, { ts: now, count: 1 });
    return false;
  }
  cur.count += 1;
  return cur.count > RATE_MAX;
}

/* Per-user AI budget (cost control on the Free Tier): a rolling 24h
 * window over ai_usage rows, capped by ai_config.daily_request_limit.
 * Admin tokens bypass the budget (they run the dashboards). */
const AI_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
async function aiBudgetExceeded(userId: string): Promise<boolean> {
  try {
    const [cfg] = await db.select().from(aiConfigTable).limit(1);
    const limit = cfg?.dailyRequestLimit ?? 1000;
    if (limit <= 0) return false;
    const since = new Date(Date.now() - AI_BUDGET_WINDOW_MS);
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(aiUsageTable)
      .where(and(eq(aiUsageTable.userId, userId), gte(aiUsageTable.createdAt, since)));
    return Number(row?.n || 0) >= limit;
  } catch {
    return false; // budget check must never block a paying user
  }
}

type ChatBody = {
  system?: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  max_tokens?: number;
  model?: string;
  /* Client-supplied OWN context — used by get_portfolio / get_alerts tools.
   * Never trusted for anything else and never used to look up other users. */
  portfolio?: Array<{ sym: string; price: number; qty: number }>;
  alerts?: Array<{ title?: string; body?: string; ts?: number; icon?: string }>;
  /* Only the free-form chat opts into server-side conversation memory;
   * one-shot flows (signals, morning report, article analysis) must NOT
   * get previous chat turns prepended — they carry their own data. */
  memory?: boolean;
};

/* Admin AI toggle (ai_config.analyzer_enabled) — lets the admin panel actually
 * turn the AI features off without a redeploy. Defaults to enabled. */
async function isAiEnabled(): Promise<boolean> {
  try {
    const [cfg] = await db.select().from(aiConfigTable).limit(1);
    return cfg?.analyzerEnabled ?? true;
  } catch {
    return true;
  }
}

async function logAiUsage(userId: string, requestType: string, tokensEstimate: number): Promise<void> {
  try {
    await db.insert(aiUsageTable).values({ userId, requestType, tokensEstimate });
  } catch (e) {
    logger.warn({ err: e }, "ai usage log failed");
  }
}

/* ─── explicit "no data" line the frontend maps to a friendly message ── */
const NO_DATA_MSG = "لم أتمكن من الوصول إلى بيانات حديثة لهذا الطلب حاليًا. حاول بعد لحظات أو اسأل سؤالًا آخر.";

/* The local engine reads live snapshots; on a cold serverless instance that
 * build can take seconds. Bounding it keeps the whole request inside the
 * platform's 60s function limit, so a slow upstream still ends in an honest
 * message instead of a platform 504 with no body. */
const LOCAL_FALLBACK_TIMEOUT_MS = 8_000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("local fallback timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

router.post("/chat", async (req: Request, res: Response) => {
  const isAdmin = isAdminToken(req);
  const claims = currentUser(req);
  if (!isAdmin && !(await isVipActive(claims))) {
    /* 401 only when there is no session at all; a signed-in non-VIP user gets
     * 403 so the UI can say "VIP required" instead of "please sign in".
     * (Session now lives in an httpOnly cookie, so the old header check no
     * longer tells the two cases apart.) */
    res
      .status(claims ? 403 : 401)
      .json({ status: "error", message: "VIP subscription required" });
    return;
  }
  if (!(await isAiEnabled())) {
    res.status(503).json({ status: "error", message: "ai_disabled_by_admin" });
    return;
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ status: "error", message: "rate_limit" });
    return;
  }

  const body = (req.body || {}) as ChatBody;
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  if (!rawMessages.length) {
    res.status(400).json({ status: "error", message: "messages array required" });
    return;
  }

  const safeMessages: ChatMsg[] = rawMessages
    .filter(
      (m): m is { role: "user" | "assistant"; content: string } =>
        m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"),
    )
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 12000) }));

  if (!safeMessages.length) {
    res.status(400).json({ status: "error", message: "no valid messages" });
    return;
  }

  /* `claims` was resolved above (the VIP gate needs it too). */
  const userKey = claims?.phone ?? (isAdmin ? "admin" : `ip:${ip}`);

  /* Cost control: per-user 24h budget (admin exempt) */
  if (!isAdmin) {
    if (await aiBudgetExceeded(userKey)) {
      res.status(429).json({ status: "error", message: "ai_daily_limit" });
      return;
    }
  }

  const systemPrompt =
    typeof body.system === "string" ? body.system.slice(0, 6000) : "";

  const maxTokens =
    typeof body.max_tokens === "number" && body.max_tokens > 0
      ? Math.min(Math.floor(body.max_tokens), 4096)
      : 2000;

  /* Memory: single-turn follow-ups get the stored context merged in;
   * multi-turn clients (chat UI) already send their own history.
   * Opt-in via body.memory so one-shot analysis flows stay lean. */
  const memKey = userKey;
  const messages = body.memory ? prepareMessages(safeMessages, memKey) : safeMessages;

  /* Sanitize client-supplied own-context (portfolio/alerts) — sizes capped,
   * numbers coerced. Nothing else is read from the body. */
  const ctx = {
    portfolio: (Array.isArray(body.portfolio) ? body.portfolio : [])
      .slice(0, 50)
      .map((p) => ({
        sym: String(p?.sym || "").toUpperCase().slice(0, 12),
        price: Number(p?.price) || 0,
        qty: Number(p?.qty) || 0,
      }))
      .filter((p) => p.sym && p.qty > 0),
    alerts: (Array.isArray(body.alerts) ? body.alerts : [])
      .slice(0, 25)
      .map((a) => ({
        title: String(a?.title || "").slice(0, 200),
        body: String(a?.body || "").slice(0, 300),
        ts: Number(a?.ts) || undefined,
        icon: String(a?.icon || "🔔").slice(0, 6),
      })),
  };

  const engine = engineName();

  try {
    const result = await runEngine(messages, systemPrompt, maxTokens, ctx);

    /* Persist the exchange for follow-up context. */
    remember(memKey, [
      ...messages.slice(-8),
      { role: "assistant" as const, content: result.text.slice(0, 2000) },
    ]);

    const approxTokens = Math.ceil(
      (messages.reduce((n, m) => n + m.content.length, 0) + result.text.length) / 4,
    );
    await logAiUsage(userKey, `chat-${result.engine}`, approxTokens);

    res.json({
      status: "ok",
      text: result.text,
      model: result.model,
      engine: result.engine,
      toolCalls: result.toolCalls,
    });
  } catch (e) {
    const err = e instanceof UpstreamError ? e : null;
    const kind = err?.kind;

    logger.warn({ err: (e as Error)?.message, kind, engine }, "ai chat engine failed");

    /* Gemini/Anthropic rate-limited upstream → surface as 429 (frontend
     * already shows the friendly "wait a minute" message). */
    if (kind === "rate_limit") {
      res.status(429).json({ status: "error", message: "rate_limit" });
      return;
    }

    /* Last resort before giving up: the local data-driven engine (real
     * live data, zero external calls). Only when the external model
     * failed — NOT a canned template: it reads the same snapshots. */
    try {
      const localText = await withTimeout(localAiChat(messages), LOCAL_FALLBACK_TIMEOUT_MS);
      if (localText && !localText.startsWith("⚠️ حدث خطأ")) {
        await logAiUsage(userKey, "chat-local-fallback", 0);
        res.json({
          status: "ok",
          text: localText,
          model: "egytrend-local",
          engine: "local",
          toolCalls: 0,
          degraded: true,
        });
        return;
      }
    } catch (le) {
      logger.warn({ err: (le as Error)?.message }, "local fallback also failed");
    }

    /* Everything failed → explicit honest message (never a fake answer). */
    if (kind === "timeout") {
      res.status(504).json({ status: "error", message: "timeout", detail: NO_DATA_MSG });
      return;
    }
    res.status(502).json({
      status: "error",
      message: "ai_upstream_failed",
      detail: NO_DATA_MSG,
    });
  }
});

/* `?verify=1` runs ONE real Gemini call from this deployment (proves the
 * env key authenticates on Vercel, not just locally). Cached 60s + shares
 * the per-IP rate limiter so a public probe can never burn quota. */
let verifyCache: { ts: number; model: string; result: GeminiVerify } | null = null;

router.get("/status", async (req: Request, res: Response) => {
  /* Staff only: this route names the upstream engine/model and, with
   * `?verify=1`, spends a REAL provider call. Leaving it public let any
   * visitor fingerprint the AI stack and (within the per-IP limit) burn free
   * tier quota. The public SPA never calls it. */
  if (!isAdminToken(req)) {
    res.status(401).json({ status: "error", message: "unauthorized" });
    return;
  }
  const engine = engineName();
  const body = {
    status: "ok",
    provisioned: Boolean(geminiKey() || anthropicKey()),
    enabled: await isAiEnabled(),
    engine,
    model: activeModel(),
  };

  if (req.query.verify === undefined || engine !== "gemini") {
    res.json(body);
    return;
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ ...body, verify: { ok: false, model: body.model, latencyMs: 0, error: "rate_limit" } });
    return;
  }

  /* Admin-only model probe (?verify=1&model=gemini-x): lets the operator
   * compare quota/health across candidate models. Clients without an admin
   * token can never make the server call an arbitrary model name. */
  const rawModel = typeof req.query.model === "string" ? req.query.model.trim() : "";
  const probeModel =
    isAdminToken(req) && /^[a-z0-9.-]{3,60}$/i.test(rawModel) ? rawModel : undefined;
  const cacheKey = probeModel || body.model;

  if (!verifyCache || verifyCache.model !== cacheKey || Date.now() - verifyCache.ts > 60_000) {
    verifyCache = { ts: Date.now(), model: cacheKey, result: await geminiVerify(probeModel) };
    logger.info(
      { ok: verifyCache.result.ok, status: verifyCache.result.status, ms: verifyCache.result.latencyMs, model: cacheKey },
      "gemini verify",
    );
  }
  res.json({ ...body, model: verifyCache.model, verify: verifyCache.result });
});

export default router;
