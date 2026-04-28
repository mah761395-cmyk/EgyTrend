import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/* Anthropic AI integration via Replit AI Integrations proxy.
 * Env vars are auto-set by the platform — never log them. */
const ANTHROPIC_BASE = process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"];
const ANTHROPIC_KEY = process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];
const DEFAULT_MODEL = "claude-sonnet-4-6";
const REQUEST_TIMEOUT_MS = 60_000;

/* Lightweight per-IP rate-limit so a runaway client can't drain the budget.
 * 30 calls per IP per minute is plenty for a single user with chat + news analysis. */
const RATE: Map<string, { ts: number; count: number }> = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;

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
  if (!ANTHROPIC_BASE || !ANTHROPIC_KEY) {
    res.status(503).json({
      status: "error",
      message:
        "AI integration not provisioned. Run setupReplitAIIntegrations for anthropic.",
    });
    return;
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ status: "error", message: "Too many AI requests, slow down." });
    return;
  }

  const body = (req.body || {}) as ChatBody;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    res.status(400).json({ status: "error", message: "messages array required" });
    return;
  }
  // Bound message size aggressively — protects upstream + budget.
  const safeMessages = messages
    .filter(
      (m): m is { role: "user" | "assistant"; content: string } =>
        m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"),
    )
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

  if (!safeMessages.length) {
    res.status(400).json({ status: "error", message: "no valid messages" });
    return;
  }

  const systemPrompt =
    typeof body.system === "string" ? body.system.slice(0, 4000) : undefined;
  const maxTokens =
    typeof body.max_tokens === "number" && body.max_tokens > 0
      ? Math.min(Math.floor(body.max_tokens), 4096)
      : 1024;
  // Frontend may pass legacy/invalid model names; keep us in known-good territory.
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
      logger.warn(
        { status: upstream.status, body: txt.slice(0, 400) },
        "ai upstream error",
      );
      res.status(502).json({
        status: "error",
        message: "AI upstream error",
        upstreamStatus: upstream.status,
      });
      return;
    }
    let data: { content?: Array<{ type: string; text?: string }> };
    try {
      data = JSON.parse(txt);
    } catch {
      res
        .status(502)
        .json({ status: "error", message: "AI returned invalid JSON" });
      return;
    }
    const text =
      (data.content || [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n")
        .trim() || "";
    res.json({ status: "ok", text, model });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    logger.warn({ err }, "ai request failed");
    res.status(aborted ? 504 : 502).json({
      status: "error",
      message: aborted ? "AI request timed out" : "AI request failed",
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
