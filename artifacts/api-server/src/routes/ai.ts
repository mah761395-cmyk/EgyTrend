import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import { currentUser, getVipEntitlement, hasVipFeature, isAdminToken } from "../lib/userAuth";
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

/* Paid/external AI is admitted before the provider call. A reservation is
 * deliberately retained even when the provider fails: under uncertainty it
 * is safer to slightly under-serve than to let retries turn into an
 * unbounded bill. Limits are bounded by code even if an admin DB row is
 * accidentally configured too high. */
const AI_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
const AI_PER_PRINCIPAL_HARD_CAP = Math.max(
  1,
  Math.min(Number(process.env["AI_PER_PRINCIPAL_DAILY_HARD_CAP"]) || 50, 1_000),
);
const AI_GLOBAL_DAILY_HARD_CAP = Math.max(
  1,
  Math.min(Number(process.env["AI_GLOBAL_DAILY_HARD_CAP"]) || 200, 5_000),
);

type AiReservation = "ok" | "limit" | "unavailable";

async function reserveExternalAiRequest(userId: string, requestType: string, tokensEstimate: number, trialDailyLimit: number | null = null): Promise<AiReservation> {
  try {
    const since = new Date(Date.now() - AI_BUDGET_WINDOW_MS);
    const [cfg] = await db.select().from(aiConfigTable).limit(1);
    /* 0 means disabled, not unlimited. A malformed value is bounded by the
     * code cap, so neither an outage nor a bad dashboard entry opens spend. */
    const configured = Number(cfg?.dailyRequestLimit ?? AI_PER_PRINCIPAL_HARD_CAP);
    const configuredLimit = Number.isFinite(configured)
      ? Math.max(0, Math.min(Math.floor(configured), AI_PER_PRINCIPAL_HARD_CAP))
      : AI_PER_PRINCIPAL_HARD_CAP;
    /* A trial cap is captured server-side at trial start. It can only tighten
     * the platform-wide per-principal policy, never raise it. */
    const trialLimit = Number.isInteger(trialDailyLimit)
      ? Math.max(0, Math.min(Number(trialDailyLimit), AI_PER_PRINCIPAL_HARD_CAP))
      : null;
    const perPrincipalLimit = trialLimit === null ? configuredLimit : Math.min(configuredLimit, trialLimit);
    if (perPrincipalLimit === 0) return "limit";

    const [principalUsage] = await db
      .select({ n: sql<number>`count(*)` })
      .from(aiUsageTable)
      .where(and(eq(aiUsageTable.userId, userId), gte(aiUsageTable.createdAt, since)));
    if (Number(principalUsage?.n || 0) >= perPrincipalLimit) return "limit";

    const [globalUsage] = await db
      .select({ n: sql<number>`count(*)` })
      .from(aiUsageTable)
      .where(gte(aiUsageTable.createdAt, since));
    if (Number(globalUsage?.n || 0) >= AI_GLOBAL_DAILY_HARD_CAP) return "limit";

    await db.insert(aiUsageTable).values({ userId, requestType, tokensEstimate });
    return "ok";
  } catch (e) {
    logger.warn({ err: e }, "AI budget reservation unavailable");
    return "unavailable";
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

/* Admin AI toggle (ai_config.analyzer_enabled). A database failure fails
 * closed so a control-plane outage cannot trigger paid provider traffic. */
async function isAiEnabled(): Promise<boolean> {
  try {
    const [cfg] = await db.select().from(aiConfigTable).limit(1);
    return cfg?.analyzerEnabled ?? true;
  } catch (e) {
    logger.warn({ err: e }, "AI enablement check unavailable");
    return false;
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
  const claims = currentUser(req);
  const isAdmin = isAdminToken(req);
  const entitlement = !isAdmin ? await getVipEntitlement(claims) : null;
  if (!isAdmin && !(await hasVipFeature(claims, "ai"))) {
    res.status(req.header("authorization") ? 403 : 401).json({ status: "error", message: "VIP subscription required" });
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
    /* Bound both context tokens and provider spend before the request leaves
     * the server; client controls are never treated as a spending limit. */
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2500) }));

  if (!safeMessages.length) {
    res.status(400).json({ status: "error", message: "no valid messages" });
    return;
  }

  /* Never use a phone/email as an AI memory or usage identifier. Admin
   * sessions share a bounded operator bucket instead of bypassing cost caps. */
  const userKey = claims ? `user:${claims.sub}` : isAdmin ? "admin" : `ip:${ip}`;

  const systemPrompt =
    typeof body.system === "string" ? body.system.slice(0, 3000) : "";

  const maxTokens =
    typeof body.max_tokens === "number" && body.max_tokens > 0
      ? Math.min(Math.floor(body.max_tokens), 2048)
      : 1200;

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
  if (engine !== "local") {
    const reservation = await reserveExternalAiRequest(
      userKey,
      `chat-${engine}-reserved`,
      maxTokens,
      entitlement?.subscriptionType === "trial" ? entitlement.trialAiDailyLimit : null,
    );
    if (reservation === "limit") {
      res.status(429).json({ status: "error", message: "ai_daily_limit" });
      return;
    }
    if (reservation === "unavailable") {
      res.status(503).json({ status: "error", message: "ai_budget_unavailable" });
      return;
    }
  }

  try {
    const result = await runEngine(messages, systemPrompt, maxTokens, ctx);

    /* Persist the exchange for follow-up context. */
    remember(memKey, [
      ...messages.slice(-8),
      { role: "assistant" as const, content: result.text.slice(0, 2000) },
    ]);

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

    logger.warn({ err: e, kind, engine }, "ai chat engine failed");

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
      logger.warn({ err: le }, "local fallback also failed");
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

/* A live provider probe is an explicit, authenticated operational action.
 * It is cached and separately throttled because each invocation consumes
 * quota even when the normal chat endpoint is idle. */
const VERIFY_RATE: Map<string, number[]> = new Map();
const VERIFY_WINDOW_MS = 15 * 60 * 1000;
const VERIFY_MAX = 3;

function verificationRateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (VERIFY_RATE.get(key) || []).filter((ts) => now - ts < VERIFY_WINDOW_MS);
  if (recent.length >= VERIFY_MAX) {
    VERIFY_RATE.set(key, recent);
    return true;
  }
  recent.push(now);
  VERIFY_RATE.set(key, recent);
  return false;
}

let verifyCache: { ts: number; model: string; result: GeminiVerify } | null = null;
let verifyInFlight: Promise<GeminiVerify> | null = null;

async function cachedGeminiVerification(model: string): Promise<GeminiVerify> {
  if (verifyCache && verifyCache.model === model && Date.now() - verifyCache.ts <= 5 * 60_000) {
    return verifyCache.result;
  }
  if (!verifyInFlight) {
    verifyInFlight = geminiVerify().then((result) => {
      verifyCache = { ts: Date.now(), model, result };
      return result;
    }).finally(() => {
      verifyInFlight = null;
    });
  }
  return verifyInFlight;
}

router.get("/status", async (req: Request, res: Response) => {
  const engine = engineName();
  const body = {
    status: "ok",
    provisioned: Boolean(geminiKey() || anthropicKey()),
    enabled: await isAiEnabled(),
    engine,
    model: activeModel(),
  };

  if (req.query.verify !== "1") {
    res.json(body);
    return;
  }

  if (!isAdminToken(req)) {
    res.status(403).json({ status: "error", message: "admin authorization required" });
    return;
  }
  if (engine !== "gemini") {
    res.status(409).json({ ...body, verify: { ok: false, model: body.model, latencyMs: 0, error: "gemini_not_configured" } });
    return;
  }

  /* Never let a query parameter pick an arbitrary provider model: probes are
   * limited to the configured production model, avoiding accidental costly
   * model selection from a URL or bookmark. */
  if (typeof req.query.model === "string" && req.query.model.trim() !== body.model) {
    res.status(400).json({ status: "error", message: "verification uses the configured model only" });
    return;
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (verificationRateLimited(ip)) {
    res.status(429).json({ ...body, verify: { ok: false, model: body.model, latencyMs: 0, error: "rate_limit" } });
    return;
  }

  const result = await cachedGeminiVerification(body.model);
  logger.info({ ok: result.ok, status: result.status, ms: result.latencyMs, model: body.model }, "gemini verify");
  res.json({ ...body, verify: result });
});

export default router;
