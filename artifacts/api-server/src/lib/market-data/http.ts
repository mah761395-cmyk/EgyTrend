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

export type ResilientFetchOptions = {
  providerId: string;
  timeoutMs?: number;
  attempts?: number;
  minIntervalMs?: number;
  headers?: Record<string, string>;
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
    const attempts = Math.max(1, Math.min(3, opts.attempts ?? 2));
    const timeoutMs = Math.max(500, opts.timeoutMs ?? 8_000);
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      await this.gate.wait(opts.providerId, opts.minIntervalMs ?? 0);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetcher(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": "EgyTrend-MarketData/1.0 (+backend-only)",
            ...(opts.headers ?? {}),
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          const error = new UpstreamHttpError(`upstream HTTP ${response.status}`, response.status);
          if (!retryable || attempt + 1 === attempts) throw error;
          lastError = error;
        } else {
          try {
            return await response.json() as T;
          } catch {
            throw new UpstreamHttpError("upstream returned invalid JSON", response.status);
          }
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

      // Exponential backoff with deterministic bounded jitter. No unbounded retry.
      const backoff = 250 * (2 ** attempt) + (attempt * 37);
      await this.sleep(backoff);
    }

    logger.warn({
      provider: opts.providerId,
      failure: safeUpstreamErrorSummary(lastError),
    }, "market upstream request exhausted retries");
    throw lastError instanceof Error ? lastError : new UpstreamHttpError("market upstream request failed");
  }
}
