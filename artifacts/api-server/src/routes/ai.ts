import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import { currentUser, isAdminToken, isVipClaims } from "../lib/userAuth";

const router: IRouter = Router();

const ANTHROPIC_BASE = process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"];
const ANTHROPIC_KEY = process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];
const DEFAULT_MODEL = "claude-sonnet-4-6";
const REQUEST_TIMEOUT_MS = 90_000;

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

type ChatBody = {
  system?: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  max_tokens?: number;
  model?: string;
};

router.post("/chat", async (req: Request, res: Response) => {
  if (!isAdminToken(req) && !isVipClaims(currentUser(req))) {
    res.status(req.header("authorization") ? 403 : 401).json({ status: "error", message: "VIP subscription required" });
    return;
  }
  if (!ANTHROPIC_BASE || !ANTHROPIC_KEY) {
    res.status(503).json({
      status: "error",
      message: "AI integration not provisioned. Run setupReplitAIIntegrations for anthropic.",
    });
    return;
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ status: "error", message: "rate_limit" });
    return;
  }

  const body = (req.body || {}) as ChatBody;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    res.status(400).json({ status: "error", message: "messages array required" });
    return;
  }

  const safeMessages = messages
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

  const systemPrompt =
    typeof body.system === "string" ? body.system.slice(0, 6000) : undefined;

  /* Allow up to 8192 tokens — Claude Sonnet supports it and long Arabic responses need it */
  const maxTokens =
    typeof body.max_tokens === "number" && body.max_tokens > 0
      ? Math.min(Math.floor(body.max_tokens), 8192)
      : 2000;

  const model = DEFAULT_MODEL;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: safeMessages,
      }),
    });

    const txt = await upstream.text();
    if (!upstream.ok) {
      logger.warn({ status: upstream.status, body: txt.slice(0, 400) }, "ai upstream error");
      const isRateLimit = upstream.status === 429;
      res.status(isRateLimit ? 429 : 502).json({
        status: "error",
        message: isRateLimit ? "rate_limit" : "AI upstream error",
        upstreamStatus: upstream.status,
      });
      return;
    }

    let data: {
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string;
    };
    try {
      data = JSON.parse(txt);
    } catch {
      res.status(502).json({ status: "error", message: "AI returned invalid JSON" });
      return;
    }

    const text =
      (data.content || [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n")
        .trim() || "";

    if (!text) {
      logger.warn({ stop_reason: data.stop_reason }, "ai returned empty text");
      res.status(502).json({ status: "error", message: "AI returned empty response" });
      return;
    }

    res.json({ status: "ok", text, model, stop_reason: data.stop_reason });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    logger.warn({ err }, aborted ? "ai request timed out" : "ai request failed");
    res.status(aborted ? 504 : 502).json({
      status: "error",
      message: aborted ? "timeout" : "AI request failed",
    });
  } finally {
    clearTimeout(t);
  }
});

router.get("/status", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    provisioned: Boolean(ANTHROPIC_BASE && ANTHROPIC_KEY),
    model: DEFAULT_MODEL,
  });
});

export default router;
