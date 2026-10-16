import Redis from "ioredis";
import { logger } from "../logger";

export type CacheMode = "redis" | "memory";

export type CachedValue<T> = {
  value: T;
  cachedAt: number;
  expiresAt: number;
  staleUntil: number;
};

export interface JsonCache {
  readonly mode: CacheMode;
  get<T>(key: string): Promise<CachedValue<T> | null>;
  set<T>(key: string, entry: CachedValue<T>): Promise<void>;
  status(): { mode: CacheMode; available: boolean };
}

/**
 * A bounded in-process cache. It is deliberately a fallback rather than a
 * substitute for Redis: a serverless cold start loses it, which is surfaced
 * by the health endpoint as degraded cache durability.
 */
export class MemoryJsonCache implements JsonCache {
  readonly mode = "memory" as const;
  private readonly entries = new Map<string, CachedValue<unknown>>();

  constructor(private readonly maxEntries = 500) {}

  async get<T>(key: string): Promise<CachedValue<T> | null> {
    const value = this.entries.get(key) as CachedValue<T> | undefined;
    if (!value) return null;
    if (value.staleUntil <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return value;
  }

  async set<T>(key: string, entry: CachedValue<T>): Promise<void> {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }

  status(): { mode: CacheMode; available: boolean } {
    return { mode: this.mode, available: true };
  }
}

/**
 * Redis cache with fail-safe memory fallback. Redis is lazily connected so a
 * missing/unreachable optional cache never blocks an API request or process
 * startup. Keys hold only public market payloads, never provider keys or PII.
 */
export class RedisJsonCache implements JsonCache {
  readonly mode = "redis" as const;
  private readonly fallback: MemoryJsonCache;
  private client: Redis | null = null;
  private attempted = false;
  private available = false;

  constructor(
    private readonly redisUrl: string,
    fallback?: MemoryJsonCache,
  ) {
    this.fallback = fallback ?? new MemoryJsonCache();
  }

  private getClient(): Redis | null {
    if (this.client) return this.client;
    if (this.attempted) return null;
    this.attempted = true;
    try {
      this.client = new Redis(this.redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        connectTimeout: 1_500,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      this.client.on("error", () => {
        this.available = false;
      });
      return this.client;
    } catch {
      return null;
    }
  }

  async get<T>(key: string): Promise<CachedValue<T> | null> {
    const client = this.getClient();
    if (client) {
      try {
        if (client.status === "wait") await client.connect();
        const raw = await client.get(key);
        if (raw) {
          const parsed = JSON.parse(raw) as CachedValue<T>;
          if (
            parsed &&
            typeof parsed.cachedAt === "number" &&
            typeof parsed.expiresAt === "number" &&
            typeof parsed.staleUntil === "number" &&
            parsed.staleUntil > Date.now()
          ) {
            this.available = true;
            return parsed;
          }
          if (parsed?.staleUntil && parsed.staleUntil <= Date.now()) await client.del(key);
        }
      } catch (err) {
        this.available = false;
        logger.warn({ err }, "market Redis get failed; using in-memory cache");
      }
    }
    return this.fallback.get<T>(key);
  }

  async set<T>(key: string, entry: CachedValue<T>): Promise<void> {
    await this.fallback.set(key, entry);
    const client = this.getClient();
    if (!client) return;
    try {
      if (client.status === "wait") await client.connect();
      const ttl = Math.max(1_000, entry.staleUntil - Date.now());
      await client.set(key, JSON.stringify(entry), "PX", ttl);
      this.available = true;
    } catch (err) {
      this.available = false;
      logger.warn({ err }, "market Redis set failed; retained in-memory cache");
    }
  }

  status(): { mode: CacheMode; available: boolean } {
    return { mode: this.mode, available: this.available };
  }
}

export function createMarketCache(env: NodeJS.ProcessEnv = process.env): JsonCache {
  const url = (env["REDIS_URL"] || "").trim();
  return url ? new RedisJsonCache(url) : new MemoryJsonCache();
}

export function cacheEntry<T>(value: T, ttlMs: number, staleMs: number, now = Date.now()): CachedValue<T> {
  return {
    value,
    cachedAt: now,
    expiresAt: now + ttlMs,
    staleUntil: now + Math.max(ttlMs, staleMs),
  };
}

export async function loadCached<T>(
  cache: JsonCache,
  key: string,
  ttlMs: number,
  staleMs: number,
  loader: () => Promise<T>,
): Promise<{ value: T; stale: boolean; cachedAt: number; cacheHit: boolean }> {
  const existing = await cache.get<T>(key);
  if (existing && existing.expiresAt > Date.now()) {
    return { value: existing.value, stale: false, cachedAt: existing.cachedAt, cacheHit: true };
  }

  try {
    const value = await loader();
    const entry = cacheEntry(value, ttlMs, staleMs);
    await cache.set(key, entry);
    return { value, stale: false, cachedAt: entry.cachedAt, cacheHit: false };
  } catch (err) {
    if (existing && existing.staleUntil > Date.now()) {
      return { value: existing.value, stale: true, cachedAt: existing.cachedAt, cacheHit: true };
    }
    throw err;
  }
}
