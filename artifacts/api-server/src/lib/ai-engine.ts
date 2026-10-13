/* ═══════════════════════════════════════════════════════════════════
   EgyTrend AI Engine (pluggable)
   ───────────────────────────────────────────────────────────────────
   Provider order (change without rebuilding the platform — env only):
     1. GEMINI_API_KEY      → Gemini function-calling loop (PRIMARY)
     2. ANTHROPIC_API_KEY   → Claude plain chat (previous behavior)
     3. none                 → local data-driven engine (localAiChat)

   Gemini flow: model picks tools → we run them in-process against the
   real EgyTrend snapshots → results go back → model writes the final
   Arabic answer grounded in those results. No invented numbers: the
   system prompt forbids quoting anything that did not come from a tool
   result, and tool failures return explicit Arabic "no data" messages.

   Secrets: keys are read from env ONLY (server side). Never serialized
   into a response, never shipped to the browser.
   ─────────────────────────────────────────────────────────────────── */

import { logger } from "./logger";
import {
  TOOL_DECLARATIONS,
  runTool,
  warmSnapshots,
  type PortItem,
  type AlertItem,
} from "./ai-tools";
import { localAiChat } from "./local-ai";

export type ChatMsg = { role: "user" | "assistant"; content: string };

export type EngineContext = {
  portfolio?: PortItem[];
  alerts?: AlertItem[];
};

export type EngineResult = {
  text: string;
  engine: "gemini" | "anthropic" | "local";
  model: string;
  toolCalls: number;
};

export type EngineError = {
  kind: "rate_limit" | "timeout" | "upstream" | "empty";
  message: string;
  upstreamStatus?: number;
};

/* ─── env ──────────────────────────────────────────────────────────── */
export function geminiKey(): string {
  /* Canonical name first, then common alternates — including the names the
   * owner created in the Vercel dashboard ("Gemini1A", "Gemini") so a
   * mis-named env var still works without renaming it in the dashboard.
   * Last resort: any env key containing "gemini" (case-insensitive) whose
   * value looks like a key — excluding model/base-url vars. */
  const direct =
    process.env["GEMINI_API_KEY"] ||
    process.env["GOOGLE_API_KEY"] ||
    process.env["AI_INTEGRATIONS_GOOGLE_API_KEY"] ||
    process.env["Gemini1A"] ||
    process.env["Gemini"] ||
    "";
  if (direct) return direct;
  for (const [k, v] of Object.entries(process.env)) {
    const lk = k.toLowerCase();
    if (v && lk.includes("gemini") && !/model|base|url|endpoint/.test(lk)) return v;
  }
  return "";
}
export function anthropicKey(): string {
  return (
    process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"] ||
    process.env["ANTHROPIC_API_KEY"] ||
    ""
  );
}
export function anthropicBase(): string {
  return process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"] || "https://api.anthropic.com";
}
/* Model is swappable via env — no rebuild needed.
 * Default = gemini-3.5-flash-lite, chosen empirically on production:
 *   - gemini-2.5-flash / 2.5-flash-lite → 404 (retired for new key holders)
 *   - gemini-3.8-flash → free tier allows only ~20 requests/day (429
 *     "Quota exceeded … limit: 20"), unusable for a live site
 *   - gemini-3.5-flash-lite → OK, fastest of the candidates (~470ms ping)
 * Google names it as the successor when 2.5-flash-lite 404s. */
function geminiModel(): string {
  return process.env["GEMINI_MODEL"] || "gemini-3.5-flash-lite";
}
function anthropicModel(): string {
  return process.env["ANTHROPIC_MODEL"] || "claude-sonnet-4-6";
}

export function engineName(): "gemini" | "anthropic" | "local" {
  if (geminiKey()) return "gemini";
  if (anthropicKey()) return "anthropic";
  return "local";
}
export function activeModel(): string {
  const e = engineName();
  return e === "gemini" ? geminiModel() : e === "anthropic" ? anthropicModel() : "egytrend-local";
}

/* ─── system prompt (grounding rules — the anti-hallucination core) ─── */
const BASE_SYSTEM = `أنت "EgyTrend AI" — مساعد وتحليلي داخل منصة EgyTrend للمستثمرين في البورصة المصرية. تتحدث بالعربية الفصحى المبسطة.

قواعد صارمة:
1) البيانات: لا تذكر أي رقم (سعر، نسبة، حجم، P/E، خبر) لم يظهر في: (أ) نتائج الأدوات التي استدعيتها، (ب) نص سؤال المستخدم، (ج) سياق المحادثة. إن لم تستدعِ أداة مناسبة، استدعِها قبل الإجابة.
2) إن أعادت أداة ok:false أو "لا تتوفر بيانات" أو قائمة فارغة، انقل الحقيقة صراحةً: «لم أتمكن من الوصول إلى بيانات حديثة لهذا الطلب حاليًا.» ولا تعوّضها ببيانات من عندك.
3) الغموض: إذا كان السؤال يحتمل أكثر من معنى (مثال: "أخبار مدينة نصر" = شركة أم مدينة؟) فاسأل للتوضيح باختصار، أو وضّح افتراضك صراحةً قبل التحليل.
4) سياق المحادثة: اربط أسئلة المتابعة بما قبلها (مثل "وإيه وضعها على المدى القصير؟" تعني آخر سهم/شركة ذُكرت).
5) المصادر: عند توفره اذكر مصدر/وقت البيانات (مثال: "كما في آخر العناوين من N مصدرًا") والافتراضات التي بنيت عليها أي قراءة.
6) الأمان: أنت للقراءة والتحليل فقط — لا تنفذ عمليات شراء/بيع/تعديل، ولا تطلب بيانات شخصية، ولا تعطي ضمانات ربح.
7) الطول: إجابة مباشرة مفيدة، نقطية عند الحاجة، بلا حشو ولا مقدمات شكر.
8) التوصيات: أي قراءة استثمارية هي تحليل تعليمي مبني على البيانات المتاحة وليس نصيحة ملزمة.`;

/* ─── memory (in-process, per-user, bounded) ─────────────────────────
   Keeps conversation context across stateless serverless invocations.
   Stores ONLY the last N turns, keyed by user id or IP, 30 min TTL,
   capped entry size. No personal data beyond the conversation itself. */
type MemEntry = { turns: ChatMsg[]; ts: number };
const MEMORY = new Map<string, MemEntry>();
const MEM_TURNS = 8;          // per side (user+assistant combined cap = 8 msgs)
const MEM_TTL_MS = 30 * 60 * 1000;
const MEM_MAX_ENTRIES = 500;

export function remember(key: string, messages: ChatMsg[]): void {
  if (!key) return;
  const now = Date.now();
  if (MEMORY.size >= MEM_MAX_ENTRIES) {
    for (const [k, v] of MEMORY) if (now - v.ts > MEM_TTL_MS) MEMORY.delete(k);
    while (MEMORY.size >= MEM_MAX_ENTRIES) {
      const first = MEMORY.keys().next().value;
      if (first === undefined) break;
      MEMORY.delete(first);
    }
  }
  const trimmed = messages.slice(-MEM_TURNS).map((m) => ({
    role: m.role,
    content: m.content.slice(0, 2000),
  }));
  MEMORY.set(key, { turns: trimmed, ts: now });
}

export function recall(key: string): ChatMsg[] {
  if (!key) return [];
  const e = MEMORY.get(key);
  if (!e) return [];
  if (Date.now() - e.ts > MEM_TTL_MS) {
    MEMORY.delete(key);
    return [];
  }
  return e.turns;
}

/* ─── message preparation (context merge + size caps = cost control) ── */
export function prepareMessages(incoming: ChatMsg[], memKey: string): ChatMsg[] {
  const hist = recall(memKey);
  // Client already sends its own history → trust it (avoid duplicates).
  if (incoming.length >= 2) return incoming.slice(-16);
  // Single follow-up question → merge server-side memory for continuity.
  const last = incoming[incoming.length - 1];
  const merged: ChatMsg[] = [];
  for (const t of hist) {
    if (last && t.role === "user" && t.content === last.content) continue;
    merged.push(t);
  }
  merged.push(...incoming);
  return merged.slice(-16);
}

/* ─── Gemini function-calling loop ──────────────────────────────────── */
type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};
/* Gemini roles are only "user" and "model" — a "function" role (the OpenAI
 * convention) is rejected with 400 "Role 'function' is not supported".
 * Tool results must be sent back as a "user" turn carrying functionResponse
 * parts. */
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

const GEMINI_TIMEOUT_MS = 45_000;
/* Soft per-attempt ceiling: a single model call that has not answered within
 * this many ms is abandoned so the chain below can still try the next model
 * inside the request budget. Measured live: the free-tier flash models answer
 * in 5-15s per round but occasionally stall well past 15s — without a soft
 * cap one stalled round eats the entire deadline and the chat degrades even
 * though a sibling model was idle. Override: GEMINI_ATTEMPT_TIMEOUT_MS. */
const GEMINI_ATTEMPT_MS = Math.max(
  5_000,
  Math.min(Number(process.env["GEMINI_ATTEMPT_TIMEOUT_MS"]) || 15_000, GEMINI_TIMEOUT_MS),
);
/* Whole-loop budget: Vercel gives this function 60s (vercel.json
 * maxDuration). Without a global deadline, MAX_TOOL_ROUNDS × 45s could
 * run past the platform limit and the request would be killed mid-flight.
 * It also has to leave room for the local engine fallback in the route, so
 * it stays well under the 60s ceiling. */
const GEMINI_TOTAL_BUDGET_MS = 45_000;
const MAX_TOOL_ROUNDS = 5;
/* A round trip must have at least this much budget left to be worth
 * starting — below it the local engine answers faster and honestly. */
const MIN_ROUND_BUDGET_MS = 4_000;
/* Override only for proxies/self-hosted gateways — default stays Google. */
function geminiBaseUrl(): string {
  return (process.env["GEMINI_BASE_URL"] || "https://generativelanguage.googleapis.com").replace(
    /\/+$/,
    "",
  );
}

class UpstreamError extends Error {
  constructor(
    message: string,
    public kind: EngineError["kind"],
    public upstreamStatus?: number,
  ) {
    super(message);
  }
}

async function geminiRequestOnce(
  contents: GeminiContent[],
  system: string,
  maxTokens: number,
  timeoutMs: number = GEMINI_TIMEOUT_MS,
  modelOverride?: string,
): Promise<{ parts: GeminiPart[]; finishReason?: string }> {
  const key = geminiKey();
  const url = `${geminiBaseUrl()}/v1beta/models/${encodeURIComponent(modelOverride || geminiModel())}:generateContent`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(1_000, timeoutMs));
  try {
    const r = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `${BASE_SYSTEM}\n\n${system || ""}`.slice(0, 8000) }] },
        contents,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        generationConfig: {
          maxOutputTokens: Math.min(Math.max(maxTokens, 512), 4096),
          temperature: 0.35,
        },
        safetySettings: [],
      }),
    });
    const txt = await r.text();
    if (!r.ok) {
    let msg = txt.slice(0, 400);
    try {
      const j = JSON.parse(txt) as { error?: { message?: string } };
      if (j.error?.message) msg = j.error.message.slice(0, 400);
    } catch { /* keep raw */ }
    /* Google echoes the sent key back inside some 401 body shapes —
     * NEVER forward that to a client. Strip anything key-like first. */
    msg = msg.replace(/(?:(?:x-goog-api-key|key|api[-_]?)\s*[:=]\s*["']?)?\b([A-Za-z0-9_\-\.]{25,})\b/g, "[redacted]");
      logger.warn({ status: r.status, msg }, "gemini upstream error");
      if (r.status === 429) throw new UpstreamError("gemini rate limited", "rate_limit", 429);
      if (r.status === 503 || r.status === 502) throw new UpstreamError(msg, "upstream", r.status);
      throw new UpstreamError(msg, "upstream", r.status);
    }
    let data: {
      candidates?: Array<{
        content?: { parts?: GeminiPart[] };
        finishReason?: string;
      }>;
    };
    try {
      data = JSON.parse(txt);
    } catch {
      throw new UpstreamError("gemini returned invalid JSON", "upstream", r.status);
    }
    const cand = data.candidates?.[0];
    if (!cand) {
      throw new UpstreamError("gemini returned no candidates", "empty", r.status);
    }
    return { parts: cand.content?.parts || [], finishReason: cand.finishReason };
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    const aborted = (e as Error)?.name === "AbortError";
    if (aborted) throw new UpstreamError("gemini timeout", "timeout");
    throw new UpstreamError((e as Error)?.message || "gemini fetch failed", "upstream");
  } finally {
    clearTimeout(t);
  }
}

/* Google intermittently answers 503 "high demand" / 429 under load (seen
 * live on production: verify flips ok:true ↔ 503 within seconds). One bad
 * answer used to drop the whole chat to the local fallback engine. Retry
 * those transient statuses a couple of times INSIDE the caller's own time
 * budget; hard failures (400/401/404) still throw immediately. */
const GEMINI_RETRY_DELAYS_MS = [700, 1600];

/* Transient answers (503 "high demand", 429 per-minute quota) are per-MODEL,
 * and the Free Tier's limits are shared by every visitor of this deployment,
 * so one model can be saturated while a sibling is idle. Walk a bounded chain
 * of models before giving up — a brief upstream blip must never drop the user
 * onto the local canned engine (which reads as "the AI didn't really answer").
 * GEMINI_MODEL_FALLBACKS (comma-separated) overrides the default successor. */
function geminiModelChain(override?: string): string[] {
  if (override) return [override];
  const extra = (process.env["GEMINI_MODEL_FALLBACKS"] || "gemini-3.6-flash")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([geminiModel(), ...extra])].slice(0, 2);
}

async function geminiRequest(
  contents: GeminiContent[],
  system: string,
  maxTokens: number,
  timeoutMs: number = GEMINI_TIMEOUT_MS,
  modelOverride?: string,
): Promise<{ parts: GeminiPart[]; finishReason?: string; model: string }> {
  const deadline = Date.now() + timeoutMs;
  const models = geminiModelChain(modelOverride);
  let last: UpstreamError | null = null;
  for (const model of models) {
    for (let attempt = 0; attempt <= GEMINI_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, GEMINI_RETRY_DELAYS_MS[attempt - 1]));
      }
      const left = deadline - Date.now();
      if (attempt > 0 && left < 1_500) break; // no time left for another try
      const t0 = Date.now();
      try {
        const out = await geminiRequestOnce(
          contents,
          system,
          maxTokens,
          Math.max(1_000, Math.min(left, GEMINI_ATTEMPT_MS)),
          model,
        );
        return { ...out, model };
      } catch (e) {
        if (!(e instanceof UpstreamError)) throw e;
        last = e;
        /* A stalled model is not worth retrying on itself (a second 15s
         * wait usually stalls the same way) — hand the remaining budget to
         * the next model in the chain instead of giving up on the user. */
        if (e.kind === "timeout") {
          logger.warn(
            { model, attempt: attempt + 1, ms: Date.now() - t0, budgetLeftMs: left },
            "gemini round stalled — trying next model",
          );
          break;
        }
        const transient =
          e.upstreamStatus === 429 ||
          e.upstreamStatus === 502 ||
          e.upstreamStatus === 503 ||
          (e.kind === "upstream" && !e.upstreamStatus); // network-level failure
        if (!transient) throw e;
        logger.warn(
          { model, attempt: attempt + 1, status: e.upstreamStatus, kind: e.kind },
          "gemini retrying transient error",
        );
      }
    }
    /* Only fall over to the next model while there is real time left, and
     * only when a transient/stalled failure is what pushed us here. */
    const left = deadline - Date.now();
    if (left < GEMINI_ATTEMPT_MS / 2) break;
    if (models.length > 1 && last) {
      logger.warn(
        { from: model, status: last.upstreamStatus, kind: last.kind, budgetLeftMs: left },
        "gemini model failover",
      );
    }
  }
  throw last || new UpstreamError("gemini unreachable", "upstream");
}

export async function geminiChat(
  messages: ChatMsg[],
  system: string,
  maxTokens: number,
  ctx: EngineContext = {},
): Promise<EngineResult> {
  const contents: GeminiContent[] = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  /* Start the snapshot builders now: the tools read those in-process caches,
   * so on a cold serverless instance this hides the news/markets upstream
   * fetch behind the model's first round instead of adding seconds to the
   * round that first calls a tool. */
  warmSnapshots();

  let toolCalls = 0;
  let finalText = "";
  /* Which model actually served this turn (failover can swap it). */
  let usedModel = geminiModel();
  const deadline = Date.now() + GEMINI_TOTAL_BUDGET_MS;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    /* Stop before the platform (60s) cuts the request off. */
    const remaining = deadline - Date.now();
    if (remaining < MIN_ROUND_BUDGET_MS) {
      if (finalText) break; // keep text already produced alongside tool calls
      throw new UpstreamError("gemini timeout", "timeout");
    }
    const roundStart = Date.now();
    const res = await geminiRequest(contents, system, maxTokens, remaining);
    const { parts } = res;
    usedModel = res.model;
    /* Latency telemetry: without it a slow reply is indistinguishable from a
     * slow tool or a model retry in the logs. */
    logger.info(
      { round, ms: Date.now() - roundStart, model: res.model, budgetLeftMs: deadline - Date.now() },
      "gemini round",
    );

    const calls = parts.filter((p) => p.functionCall);
    const textParts = parts.filter((p) => typeof p.text === "string" && p.text.length)
      .map((p) => p.text as string);

    if (!calls.length) {
      finalText = textParts.join("\n").trim();
      break;
    }

    /* Model asked for tools → run them in-process (real data), then feed
     * results back so the NEXT answer is grounded in them. */
    contents.push({ role: "model", parts });
    const fnParts: GeminiPart[] = [];
    for (const p of calls) {
      const fc = p.functionCall!;
      const name = fc.name;
      const args = (fc.args || {}) as Record<string, unknown>;
      toolCalls += 1;
      let result: Record<string, unknown>;
      try {
        result = (await runTool(name, args, ctx)) as Record<string, unknown>;
      } catch (e) {
        result = { ok: false, error: `فشلت الأداة ${name}: ${(e as Error).message}` };
      }
      /* Keep tool payloads small (cost + context control). Every extra
       * kilobyte is re-read by the model on the NEXT round, so an 8KB
       * payload both costs tokens and buys latency on a slow round. */
      let response = result;
      const raw = JSON.stringify(result);
      if (raw.length > 3500) {
        response = { ok: result.ok, truncated: true, data: raw.slice(0, 3500) };
      }
      fnParts.push({ functionResponse: { name, response } });
      logger.info({ tool: name, ok: result.ok }, "ai tool executed");
    }
    contents.push({ role: "user", parts: fnParts });

    /* If the model also wrote text alongside tool calls this round, keep it
     * as a fallback in case the next round returns nothing. */
    if (textParts.length) finalText = textParts.join("\n").trim();
  }

  if (!finalText) {
    throw new UpstreamError("gemini produced empty response", "empty");
  }
  return { text: finalText, engine: "gemini", model: usedModel, toolCalls };
}

/* ─── Anthropic path (previous behavior, kept intact) ───────────────── */
export async function anthropicChat(
  messages: ChatMsg[],
  system: string,
  maxTokens: number,
): Promise<EngineResult> {
  const key = anthropicKey();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const r = await fetch(`${anthropicBase()}/v1/messages`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: anthropicModel(),
        max_tokens: Math.min(Math.max(maxTokens, 512), 8192),
        ...(system ? { system } : {}),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    const txt = await r.text();
    if (!r.ok) {
      logger.warn({ status: r.status, body: txt.slice(0, 300) }, "anthropic upstream error");
      if (r.status === 429) throw new UpstreamError("anthropic rate limited", "rate_limit", 429);
      throw new UpstreamError("anthropic upstream error", "upstream", r.status);
    }
    let data: { content?: Array<{ type: string; text?: string }> };
    try {
      data = JSON.parse(txt);
    } catch {
      throw new UpstreamError("anthropic invalid JSON", "upstream", r.status);
    }
    const text = (data.content || [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n")
      .trim();
    if (!text) throw new UpstreamError("anthropic empty response", "empty", r.status);
    return { text, engine: "anthropic", model: anthropicModel(), toolCalls: 0 };
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    const aborted = (e as Error)?.name === "AbortError";
    throw new UpstreamError(
      aborted ? "anthropic timeout" : "anthropic fetch failed",
      aborted ? "timeout" : "upstream",
    );
  } finally {
    clearTimeout(t);
  }
}

/* ─── connectivity probe ───────────────────────────────────────────
   A single tiny real call to Google from THIS deployment. Used by
   GET /api/ai/status?verify=1 so production can prove the env key
   actually authenticates — without needing a VIP session.
   Returns only status/latency/error text; the key never leaves the server. */
export type GeminiVerify = {
  ok: boolean;
  model: string;
  latencyMs: number;
  status?: number;
  error?: string;
};

/* Never forward anything key-like (the AQ. OAuth sample, AIza…, whatever
 * the owner pasted) in an error message shown to clients. */
function redactKeys(s: string): string {
  return s.replace(/[A-Za-z0-9_\-\.]{25,}/g, "[redacted]");
}

export async function geminiVerify(modelOverride?: string): Promise<GeminiVerify> {
  const model = modelOverride || geminiModel();
  const t0 = Date.now();
  try {
    const { parts } = await geminiRequest(
      [{ role: "user", parts: [{ text: "ping" }] }],
      "Reply with the single word: OK",
      16,
      15_000,
      model,
    );
    const text = parts
      .filter((p) => typeof p.text === "string")
      .map((p) => p.text as string)
      .join("")
      .trim();
    return text
      ? { ok: true, model, latencyMs: Date.now() - t0 }
      : { ok: false, model, latencyMs: Date.now() - t0, error: "empty response" };
  } catch (e) {
    const err = e instanceof UpstreamError ? e : null;
    return {
      ok: false,
      model,
      latencyMs: Date.now() - t0,
      status: err?.upstreamStatus,
      error: redactKeys(err?.message || "gemini unreachable").slice(0, 300),
    };
  }
}

export { UpstreamError };
export type { GeminiPart, GeminiContent };

/* ─── engine dispatch ──────────────────────────────────────────────── */
export async function runEngine(
  messages: ChatMsg[],
  system: string,
  maxTokens: number,
  ctx: EngineContext = {},
): Promise<EngineResult> {
  const name = engineName();
  if (name === "gemini") {
    return geminiChat(messages, system, maxTokens, ctx);
  }
  if (name === "anthropic") {
    return anthropicChat(messages, system, maxTokens);
  }
  const text = await localAiChat(messages);
  return { text, engine: "local", model: "egytrend-local", toolCalls: 0 };
}
