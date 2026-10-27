import { logger } from "../logger";

export type FetchLike = typeof fetch;

export class UpstreamHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpstreamHttpError";
  }
}

/**
 * Upstream/fetch errors can embed a URL, and a vendor API key may be in that
 * URL. Use a fixed classification anywhere an error leaves the request layer
 * (logs, cache state, or owner alerts); never forward `error.message` there.
 */
export function safeUpstreamErrorSummary(error: unknown): string {
  if (error instanceof UpstreamHttpError && typeof error.status === "number") {
    return `upstream HTTP ${error.status}`;
  }
  if (error instanceof Error && error.name === "AbortError") return "upstream timeout";
  return "upstream request failed";
}

/** Per-provider spacing prevents an accidental burst from consuming a quota. */
export class ProviderRateGate {
  private readonly nextAllowedAt = new Map<string, number>();

  async wait(providerId: string, minIntervalMs: number): Promise<void> {
    if (minIntervalMs <= 0) return;
    const now = Date.now();
    const next = this.nextAllowedAt.get(providerId) ?? now;
    const waitMs = Math.max(0, next - now);
    this.nextAllowedAt.set(providerId, Math.max(now, next) + minIntervalMs);
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
}

/** Max time one request may spend sleeping before a vendor retry. A rate-limit
 * window longer than this is better handled by serving the last verified
 * snapshot and trying again on the next cache cycle than by blocking the
 * request (serverless functions have a hard duration budget). */
export const MAX_RETRY_WAIT_MS = 15_000;

/** `Retry-After` is seconds or an HTTP date; anything else means "no hint". */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

export type ResilientFetchOptions = {
  providerId: string;
  timeoutMs?: number;
  attempts?: number;
  minIntervalMs?: number;
  headers?: Record<string, string>;
  body?: string;
};

/**
 * Backend-only HTTP client for data vendors. It combines a request timeout,
 * narrow retry/backoff policy and an inter-request rate gate. Credentials are
 * supplied only inside a backend provider and never passed to callers.
 */
export class ResilientHttpClient {
  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly gate = new ProviderRateGate(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async getJson<T>(url: string, opts: ResilientFetchOptions): Promise<T> {
    const responseText = await this.send(url, opts, "GET");
    try {
      return JSON.parse(responseText) as T;
    } catch {
      throw new UpstreamHttpError("upstream returned invalid JSON");
    }
  }

  /** Some public reference pages (HTML) act as name-labeled price tables;
   * they are fetched as text and parsed by the single provider that owns them. */
  async getText(url: string, opts: ResilientFetchOptions): Promise<string> {
    return this.send(url, opts, "GET");
  }

  async postJson<T>(url: string, body: unknown, opts: ResilientFetchOptions): Promise<T> {
    const responseText = await this.send(url, { ...opts, body: JSON.stringify(body) }, "POST");
    try {
      return JSON.parse(responseText) as T;
    } catch {
      throw new UpstreamHttpError("upstream returned invalid JSON");
    }
  }

  private async send(
    url: string,
    opts: ResilientFetchOptions,
    method: "GET" | "POST",
  ): Promise<string> {
    const attempts = Math.max(1, Math.min(3, opts.attempts ?? 2));
    const timeoutMs = Math.max(500, opts.timeoutMs ?? 8_000);
    let lastError: unknown;
    let lastRetryAfterMs: number | undefined;

    for (let attempt = 0; attempt < attempts; attempt++) {
      await this.gate.wait(opts.providerId, opts.minIntervalMs ?? 0);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetcher(url, {
          method,
          headers: {
            Accept: "application/json",
            "User-Agent": "EgyTrend-MarketData/1.0 (+backend-only)",
            ...(method === "POST" && opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(opts.headers ?? {}),
          },
          body: method === "POST" ? opts.body : undefined,
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          const error = new UpstreamHttpError(`upstream HTTP ${response.status}`, response.status);
          lastError = error;
          lastRetryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          /* Stop retrying when the status is not transient, this was the last
           * attempt, or the vendor's rate-limit window is longer than the cap:
           * a long window is not recoverable inside this request — the caller
           * serves its last verified snapshot and the next cache cycle retries
           * after the window has passed (serverless duration budget). A throw
           * here would be swallowed by the catch below, so break instead. */
          if (!retryable || attempt + 1 === attempts || (lastRetryAfterMs !== undefined && lastRetryAfterMs > MAX_RETRY_WAIT_MS)) break;
        } else {
          return await response.text();
        }
      } catch (err) {
        const normalized = err instanceof Error ? err : new Error("unknown upstream error");
        const isAbort = normalized.name === "AbortError";
        lastError = isAbort
          ? new UpstreamHttpError(`upstream timeout after ${timeoutMs}ms`)
          : normalized;
        if (attempt + 1 === attempts) break;
      } finally {
        clearTimeout(timeout);
      }

      // Exponential backoff with deterministic bounded jitter, widened by the
      // vendor's own Retry-After when present (still capped). No unbounded retry.
      const base = 250 * (2 ** attempt) + (attempt * 37);
      const backoff = Math.max(base, Math.min(lastRetryAfterMs ?? base, MAX_RETRY_WAIT_MS));
      await this.sleep(backoff);
    }

    logger.warn({
      provider: opts.providerId,
      failure: safeUpstreamErrorSummary(lastError),
    }, "market upstream request exhausted retries");
    throw lastError instanceof Error ? lastError : new UpstreamHttpError("market upstream request failed");
  }
}
