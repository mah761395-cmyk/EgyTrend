import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
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
const DATA_DIR = path.resolve(__dirname, "..", "data");
import embeddedSources from "../../data/sources.json" with { type: "json" };
import embeddedArticles from "../../data/articles.json" with { type: "json" };

export type SourceMeta = {
  id: string;
  name: string;
  icon: string;
  lang: "ar" | "en";
  cat: "egypt" | "global" | "stocks" | "crypto";
  color: string;
  url: string;
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
    /* Read-only/ephemeral filesystem (serverless): keep the change in memory
     * only — the admin action still succeeds for the life of the instance. */
    logger.warn({ err, file }, "dataStore: disk write unavailable, kept in memory");
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

export function listSources(): SourceMeta[] {
  return Object.values(sourcesCache);
}

export function getSource(id: string): SourceMeta | undefined {
  return sourcesCache[id];
}

export async function upsertSource(src: SourceMeta): Promise<void> {
  sourcesCache = { ...sourcesCache, [src.id]: src };
  await writeJSONAtomic(SOURCES_FILE, sourcesCache);
}

export async function deleteSource(id: string): Promise<boolean> {
  if (!sourcesCache[id]) return false;
  const next = { ...sourcesCache };
  delete next[id];
  sourcesCache = next;
  await writeJSONAtomic(SOURCES_FILE, sourcesCache);
  return true;
}

export function listCustomArticles(): CustomArticle[] {
  return [...articlesCache].sort(
    (a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime(),
  );
}

export function getCustomArticle(id: string): CustomArticle | undefined {
  return articlesCache.find((a) => a.id === id);
}

export async function upsertCustomArticle(a: CustomArticle): Promise<void> {
  const idx = articlesCache.findIndex((x) => x.id === a.id);
  if (idx >= 0) {
    articlesCache = [
      ...articlesCache.slice(0, idx),
      a,
      ...articlesCache.slice(idx + 1),
    ];
  } else {
    articlesCache = [a, ...articlesCache];
  }
  await writeJSONAtomic(ARTICLES_FILE, articlesCache);
}

export async function deleteCustomArticle(id: string): Promise<boolean> {
  const before = articlesCache.length;
  articlesCache = articlesCache.filter((a) => a.id !== id);
  if (articlesCache.length === before) return false;
  await writeJSONAtomic(ARTICLES_FILE, articlesCache);
  return true;
}

export function getDataDir(): string {
  return DATA_DIR;
}
