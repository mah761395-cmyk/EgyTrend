import { Router, type IRouter } from "express";
import { XMLParser } from "fast-xml-parser";
import { logger } from "../lib/logger";
import {
  listSources,
  getSource,
  listCustomArticles,
  type SourceMeta,
} from "../lib/dataStore";

const router: IRouter = Router();


const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  textNodeName: "#text",
  trimValues: true,
  cdataPropName: "__cdata",
});

function pickText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const t = pickText(item);
      if (t) return t;
    }
    return "";
  }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v["__cdata"] === "string") return v["__cdata"] as string;
    if (Array.isArray(v["__cdata"])) {
      const arr = v["__cdata"] as unknown[];
      const first = arr.find((x) => typeof x === "string") as
        | string
        | undefined;
      if (first) return first;
    }
    if (typeof v["#text"] === "string") return v["#text"] as string;
    if (typeof v["@_href"] === "string") return v["@_href"] as string;
  }
  return "";
}

function pickLink(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = pickLink(item);
      if (url) return url;
    }
    return "";
  }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v["@_href"] === "string") return (v["@_href"] as string).trim();
    if (typeof v["__cdata"] === "string") return (v["__cdata"] as string).trim();
    if (typeof v["#text"] === "string") return (v["#text"] as string).trim();
  }
  // Fallback: try generic text extraction
  return pickText(value).trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

function decodeEntities(input: string): string {
  if (!input) return "";
  let out = input;
  // Run twice to catch double-encoded entities (e.g. &amp;#x2019; → &#x2019; → ')
  for (let i = 0; i < 2; i++) {
    out = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X")) {
        const n = parseInt(code.slice(2), 16);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      if (code.startsWith("#")) {
        const n = parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      const named = NAMED_ENTITIES[code.toLowerCase()];
      return named !== undefined ? named : m;
    });
  }
  return out;
}

function stripHtml(input: string): string {
  if (!input) return "";
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(input: string): string {
  return decodeEntities(stripHtml(decodeEntities(input))).trim();
}

/* URLs coming from external feeds are interpolated into HTML attributes
 * client-side (img src, href, inline onclick with the guid) — restrict them
 * to http(s) and strip characters that could break out of a quoted attribute. */
function safeUrl(input: string): string {
  const v = (input || "").trim();
  if (!/^https?:\/\//i.test(v)) return "";
  return v.replace(/["'<>\\)\\]/g, "");
}

function pickImage(it: Record<string, unknown>): string | undefined {
  const enclosure = it["enclosure"] as Record<string, unknown> | undefined;
  if (
    enclosure &&
    typeof enclosure["@_url"] === "string" &&
    /^https?:\/\//.test(enclosure["@_url"] as string)
  ) {
    return enclosure["@_url"] as string;
  }
  const mediaThumb = it["media:thumbnail"] as
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | undefined;
  const mt = Array.isArray(mediaThumb) ? mediaThumb[0] : mediaThumb;
  if (mt && typeof mt["@_url"] === "string") return mt["@_url"] as string;
  const mediaContent = it["media:content"] as
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | undefined;
  const mc = Array.isArray(mediaContent) ? mediaContent[0] : mediaContent;
  if (mc && typeof mc["@_url"] === "string") return mc["@_url"] as string;
  const desc = pickText(it["description"]) || pickText(it["content:encoded"]);
  if (desc) {
    const m = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m && /^https?:\/\//.test(m[1] || "")) return m[1];
    const m2 = desc.match(/src=["']([^"']+\.(?:jpg|jpeg|png|webp))/i);
    if (m2 && /^https?:\/\//.test(m2[1] || "")) return m2[1];
  }
  return undefined;
}

type FeedItem = {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  guid: string;
  thumbnail?: string;
  enclosure?: { url: string };
};

function parseFeed(xml: string): FeedItem[] {
  const obj = parser.parse(xml) as Record<string, unknown>;
  let rawItems: Array<Record<string, unknown>> = [];

  const rss = obj["rss"] as Record<string, unknown> | undefined;
  const channel = rss?.["channel"] as Record<string, unknown> | undefined;
  if (channel?.["item"]) {
    const it = channel["item"];
    rawItems = Array.isArray(it)
      ? (it as Array<Record<string, unknown>>)
      : [it as Record<string, unknown>];
  } else {
    const feed = obj["feed"] as Record<string, unknown> | undefined;
    if (feed?.["entry"]) {
      const it = feed["entry"];
      const entries = Array.isArray(it)
        ? (it as Array<Record<string, unknown>>)
        : [it as Record<string, unknown>];
      rawItems = entries.map((e) => ({
        title: e["title"],
        link: e["link"],
        description: e["summary"] || e["content"],
        pubDate: e["published"] || e["updated"],
        guid: e["id"],
      }));
    }
  }

  return rawItems
    .map((it) => {
      const title = clean(pickText(it["title"]));
      const description = clean(
        pickText(it["description"]) ||
          pickText(it["content:encoded"]) ||
          pickText(it["summary"]) ||
          "",
      );
      const link = safeUrl(pickLink(it["link"]) || pickText(it["guid"]));
      const rawDate =
        pickText(it["pubDate"]) ||
        pickText(it["published"]) ||
        pickText(it["dc:date"]) ||
        pickText(it["updated"]) ||
        "";
      const parsed = rawDate ? new Date(rawDate) : null;
      const pubDate =
        parsed && !Number.isNaN(parsed.getTime())
          ? parsed.toISOString()
          : new Date().toISOString();
      const guid = clean(pickText(it["guid"]).replace(/["'<>\\)\\]/g, "")) || link || title;
      const img = pickImage(it);
      return {
        title,
        link,
        description,
        pubDate,
        guid,
        ...(img ? { thumbnail: safeUrl(img), enclosure: { url: safeUrl(img) } } : {}),
      };
    })
    .filter((it) => it.title && it.link);
}

type CacheEntry = {
  ts: number;
  data: { status: "ok"; items: FeedItem[]; meta: SourceMeta };
};
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;
/* Stale entries are served for up to 2 hours when upstream is unavailable */
const STALE_TTL_MS = 2 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 9000;
/* Negative cache: a source that just timed-out/failed is not retried for
 * FAIL_TTL_MS — otherwise one hung upstream forces EVERY aggregated request
 * to pay the full FETCH_TIMEOUT_MS, since only successes are cached. */
const FAIL_TTL_MS = 2 * 60 * 1000;
const FAILS = new Map<string, number>();

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) EgyTrend/1.0";

async function fetchSource(src: SourceMeta): Promise<{
  status: "ok";
  items: FeedItem[];
  meta: SourceMeta;
}> {
  const cached = CACHE.get(src.id);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  const failedAt = FAILS.get(src.id);
  if (failedAt && Date.now() - failedAt < FAIL_TTL_MS) {
    if (cached && Date.now() - cached.ts < STALE_TTL_MS) return cached.data;
    throw new Error(`upstream recently failed for ${src.id}`);
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(src.url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept:
          "application/rss+xml, application/xml, application/atom+xml, text/xml, */*",
        "Accept-Language": "ar,en;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`upstream ${res.status} for ${src.id}`);
    }
    const xml = await res.text();
    const items = parseFeed(xml).slice(0, 12);
    const data = { status: "ok" as const, items, meta: src };
    if (items.length > 0) {
      CACHE.set(src.id, { ts: Date.now(), data });
      FAILS.delete(src.id);
    }
    return data;
  } catch (err) {
    clearTimeout(t);
    FAILS.set(src.id, Date.now());
    /* Serve stale cache (up to 2 hr) rather than crashing when upstream fails */
    if (cached && Date.now() - cached.ts < STALE_TTL_MS) {
      logger.warn({ source: src.id }, "upstream failed — serving stale cache");
      return cached.data;
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

/* Build a synthetic feed entry for admin-authored articles so the frontend
 * can blend them with RSS results without a separate code path. */
function customArticlesFeed(): {
  status: "ok";
  items: FeedItem[];
  meta: SourceMeta;
} {
  const articles = listCustomArticles();
  const items: FeedItem[] = articles.map((a) => ({
    title: a.title,
    link: a.link,
    description: a.description,
    pubDate: a.pubDate,
    guid: a.id,
    ...(a.thumbnail
      ? { thumbnail: a.thumbnail, enclosure: { url: a.thumbnail } }
      : {}),
  }));
  return {
    status: "ok",
    items,
    meta: {
      id: "admin",
      name: "تحرير المنصة",
      icon: "✍️",
      lang: "ar",
      cat: "egypt",
      color: "#a855f7",
      url: "internal://admin",
    },
  };
}

router.get("/news/sources", (_req, res) => {
  const sources = listSources().map((s) => ({
    id: s.id,
    name: s.name,
    icon: s.icon,
    lang: s.lang,
    cat: s.cat,
    color: s.color,
  }));
  // Always advertise the admin pseudo-source so the UI can filter to it.
  sources.unshift({
    id: "admin",
    name: "تحرير المنصة",
    icon: "✍️",
    lang: "ar",
    cat: "egypt",
    color: "#a855f7",
  });
  res.json({ status: "ok", sources });
});

type NewsFeed = { status: "ok"; items: FeedItem[]; meta: SourceMeta };
type NewsSnapshot = {
  status: "ok";
  feeds: NewsFeed[];
  errors: Array<{ source: string; message: string }>;
};

/* Aggregated all-sources snapshot. The route and the local AI engine share
 * it — the AI engine reads it IN-PROCESS because a serverless instance has
 * no localhost HTTP listener to fetch /api/news from. The 60s TTL sits on top
 * of fetchSource's own 5-minute per-source cache, so a rebuild is cheap. */
const AGG_TTL_MS = 60 * 1000;
let newsAggCache: { ts: number; data: NewsSnapshot } | null = null;
let newsAggInFlight: Promise<NewsSnapshot | null> | null = null;

async function buildNewsAgg(): Promise<NewsSnapshot | null> {
  try {
    const sources = listSources();
    const settled = await Promise.allSettled(sources.map((s) => fetchSource(s)));
    const feeds: NewsFeed[] = [];
    const errors: Array<{ source: string; message: string }> = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") feeds.push(r.value);
      else
        errors.push({
          source: sources[i]?.id || "?",
          message: (r as PromiseRejectedResult).reason?.message || "error",
        });
    });
    // Merge admin-authored content as a first-class feed.
    const custom = customArticlesFeed();
    if (custom.items.length > 0) feeds.unshift(custom);
    if (errors.length > 0) logger.warn({ errors }, "some news sources failed");
    const data: NewsSnapshot = { status: "ok", feeds, errors };
    newsAggCache = { ts: Date.now(), data };
    return data;
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "news snapshot build failed");
    return newsAggCache ? newsAggCache.data : null;
  }
}

export function getNewsSnapshot(): Promise<NewsSnapshot | null> {
  if (newsAggCache && Date.now() - newsAggCache.ts < AGG_TTL_MS) {
    return Promise.resolve(newsAggCache.data);
  }
  if (!newsAggInFlight) {
    newsAggInFlight = buildNewsAgg().finally(() => {
      newsAggInFlight = null;
    });
  }
  return newsAggInFlight;
}

router.get("/news", async (req, res) => {
  const sourceId = String(req.query["source"] || "").trim();

  if (!sourceId || sourceId === "all") {
    const snap = await getNewsSnapshot();
    if (!snap) {
      res.status(503).json({ status: "error", message: "news unavailable" });
      return;
    }
    res.json(snap);
    return;
  }

  if (sourceId === "admin") {
    res.json(customArticlesFeed());
    return;
  }

  const src = getSource(sourceId);
  if (!src) {
    res.status(404).json({ status: "error", message: "unknown source" });
    return;
  }
  try {
    const data = await fetchSource(src);
    res.json(data);
  } catch (err) {
    logger.warn({ err, source: sourceId }, "failed to fetch news source");
    res.status(502).json({
      status: "error",
      message: (err as Error).message || "fetch failed",
      items: [],
    });
  }
});

export default router;
