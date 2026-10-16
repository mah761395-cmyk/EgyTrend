import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";

/* The data directory lives next to the build output (dist/) at
 * `<api-server>/data/`. From the bundled entry at `dist/index.mjs`,
 * `../data` resolves correctly. From source-mode tooling it works
 * the same way because we always run via the built bundle.
 *
 * Serverless note (Vercel): the filesystem can be read-only/ephemeral, so
 * the JSON is ALSO embedded into the bundle via `with { type: "json" }`
 * import attributes — when the on-disk file can't be read we fall back to
 * the embedded copy (read-only; admin edits then only live in memory for
 * the life of the function instance). Writes still work normally when a
 * writable disk exists (local / VPS). */
// The production bundle supplies __dirname via build.mjs; source-mode tests
// are native ESM and need the standard import.meta fallback instead.
const moduleDir = typeof __dirname === "string"
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(moduleDir, "..", "data");
import embeddedSources from "../../data/sources.json" with { type: "json" };
import embeddedArticles from "../../data/articles.json" with { type: "json" };

export type CommercialRedisplayReview = {
  /** Only an explicit written commercial redisplay grant can be `approved`. */
  status: "approved" | "pending" | "not_approved";
  /** Public contract/terms URL or internal contract reference; never a secret. */
  evidence?: string;
  reviewedAt?: string;
  note?: string;
};

export type SourceMeta = {
  id: string;
  name: string;
  icon: string;
  lang: "ar" | "en";
  cat: "egypt" | "global" | "stocks" | "crypto";
  color: string;
  url: string;
  /**
   * RSS availability alone is not permission to republish in a paid product.
   * Missing metadata is treated as pending, and pending sources are never fetched.
   */
  commercialRedisplay?: CommercialRedisplayReview;
  /** Soft-deletion marker; archived content is retained on disk for recovery. */
  archivedAt?: string;
};

export type CustomArticle = {
  id: string;
  title: string;
  description: string;
  content?: string;
  link: string;
  pubDate: string; // ISO
  thumbnail?: string;
  cat: "egypt" | "global" | "stocks" | "crypto";
  srcId: string; // typically "admin"
  srcName: string;
  srcIcon: string;
  srcColor: string;
  srcLang: "ar" | "en";
  /** Soft-deletion marker; archived content is retained on disk for recovery. */
  archivedAt?: string;
};

const SOURCES_FILE = path.join(DATA_DIR, "sources.json");
const ARTICLES_FILE = path.join(DATA_DIR, "articles.json");

/* Synchronous initial load — called once at boot so the rest of the app
 * has data without awaiting. Subsequent reloads use async readJSON.
 * Falls back to the bundle-embedded copy when the disk copy is unreadable
 * (e.g. read-only serverless filesystem). */
function readJSONSync<T>(file: string, embedded: T): T {
  try {
    const txt = fsSync.readFileSync(file, "utf8");
    return JSON.parse(txt) as T;
  } catch {
    return embedded;
  }
}

async function readJSON<T>(file: string, fallback: T, embedded?: T): Promise<T> {
  try {
    const txt = await fs.readFile(file, "utf8");
    return JSON.parse(txt) as T;
  } catch {
    /* read-only serverless FS: fall back to the last cache or the embedded copy */
    return embedded ?? fallback;
  }
}

async function writeJSONAtomic(file: string, data: unknown): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    // A memory-only success on an ephemeral/read-only server is deceptive:
    // the next instance would silently lose an admin edit. Fail closed so the
    // caller can show a durable-storage error and leave the cache unchanged.
    logger.error({ err, file }, "dataStore: durable write unavailable");
    throw new Error("content storage is unavailable");
  }
}

let sourcesCache: Record<string, SourceMeta> = readJSONSync(
  SOURCES_FILE,
  embeddedSources as Record<string, SourceMeta>,
);
let articlesCache: CustomArticle[] = readJSONSync(
  ARTICLES_FILE,
  embeddedArticles as CustomArticle[],
);

/* Watch for external edits to the JSON files (e.g. you edit sources.json
 * by hand) so the cache stays fresh without restart. */
function startWatcher(file: string, onChange: () => void): void {
  try {
    fsSync.watch(file, { persistent: false }, () => {
      // debounce so we coalesce burst events
      setTimeout(onChange, 60);
    });
  } catch (err) {
    logger.warn({ err, file }, "dataStore: watch failed");
  }
}

startWatcher(SOURCES_FILE, async () => {
  const fresh = await readJSON<Record<string, SourceMeta>>(SOURCES_FILE, sourcesCache);
  sourcesCache = fresh;
  logger.info({ count: Object.keys(fresh).length }, "dataStore: sources reloaded");
});
startWatcher(ARTICLES_FILE, async () => {
  const fresh = await readJSON<CustomArticle[]>(ARTICLES_FILE, articlesCache);
  articlesCache = fresh;
  logger.info({ count: fresh.length }, "dataStore: articles reloaded");
});

/* ─── Public API ─── */

/** A source is live only after a documented commercial redisplay review. */
export function isCommercialRedisplayApproved(source: SourceMeta): boolean {
  const review = source.commercialRedisplay;
  return !source.archivedAt
    && review?.status === "approved"
    && typeof review.evidence === "string"
    && review.evidence.trim().length >= 8;
}

/** Active sources are the only third-party feeds that network code may fetch. */
export function listSources(): SourceMeta[] {
  return Object.values(sourcesCache).filter(isCommercialRedisplayApproved);
}

/** Full inventory is admin-only; it includes archived/pending entries for review. */
export function listSourceInventory(): SourceMeta[] {
  return Object.values(sourcesCache);
}

export function getSource(id: string): SourceMeta | undefined {
  const source = sourcesCache[id];
  return source && isCommercialRedisplayApproved(source) ? source : undefined;
}

export async function upsertSource(src: SourceMeta): Promise<void> {
  const existing = sourcesCache[src.id];
  // Admin-created feeds always begin disabled. Approval needs a separately
  // documented legal review rather than trusting an RSS URL or a form field.
  const commercialRedisplay = existing?.commercialRedisplay ?? {
    status: "pending" as const,
    reviewedAt: new Date().toISOString(),
    note: "Awaiting documented commercial redisplay approval.",
  };
  const next = { ...sourcesCache, [src.id]: { ...src, commercialRedisplay, archivedAt: undefined } };
  await writeJSONAtomic(SOURCES_FILE, next);
  sourcesCache = next;
}

/** Archives rather than destroys a source so it can be recovered from JSON. */
export async function deleteSource(id: string): Promise<boolean> {
  const current = sourcesCache[id];
  if (!current || current.archivedAt) return false;
  const next = { ...sourcesCache, [id]: { ...current, archivedAt: new Date().toISOString() } };
  await writeJSONAtomic(SOURCES_FILE, next);
  sourcesCache = next;
  return true;
}

export function listCustomArticles(): CustomArticle[] {
  return articlesCache.filter((article) => !article.archivedAt).sort(
    (a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime(),
  );
}

export function getCustomArticle(id: string): CustomArticle | undefined {
  const article = articlesCache.find((a) => a.id === id);
  return article?.archivedAt ? undefined : article;
}

export async function upsertCustomArticle(a: CustomArticle): Promise<void> {
  const nextArticle = { ...a, archivedAt: undefined };
  const idx = articlesCache.findIndex((x) => x.id === a.id);
  const next = idx >= 0
    ? [...articlesCache.slice(0, idx), nextArticle, ...articlesCache.slice(idx + 1)]
    : [nextArticle, ...articlesCache];
  await writeJSONAtomic(ARTICLES_FILE, next);
  articlesCache = next;
}

/** Archives rather than destroys an article so it can be recovered from JSON. */
export async function deleteCustomArticle(id: string): Promise<boolean> {
  const idx = articlesCache.findIndex((a) => a.id === id && !a.archivedAt);
  if (idx < 0) return false;
  const next = [...articlesCache];
  next[idx] = { ...next[idx], archivedAt: new Date().toISOString() };
  await writeJSONAtomic(ARTICLES_FILE, next);
  articlesCache = next;
  return true;
}

export function getDataDir(): string {
  return DATA_DIR;
}
