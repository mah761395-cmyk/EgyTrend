import { promises as dns } from "node:dns";
import { isIP } from "node:net";
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

/* ─── RSS outbound-request guard ──────────────────────────────────────────
 * Feed URLs are editable metadata, so treat them as an SSRF boundary rather
 * than trusting a URL merely because it came from the source registry. Every
 * hop is manually followed, revalidated and DNS-resolved before it is fetched.
 * This blocks localhost, private/link-local/metadata ranges, credentials,
 * non-standard ports and redirects to an internal target. DNS failures fail
 * closed; a feed can be unavailable, but it must never become a network probe.
 */
type ResolvedAddress = { address: string; family: 4 | 6 };
type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;
type FeedFetch = (input: string, init: RequestInit) => Promise<Response>;

const MAX_FEED_REDIRECTS = 3;
const MAX_FEED_BYTES = 1_500_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home"];

const resolveHost: HostResolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.filter((record): record is ResolvedAddress => record.family === 4 || record.family === 6);
};

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  /* RFC 1918, loopback, link-local, CGNAT, documentation/test ranges,
   * benchmarking, multicast and future-reserved ranges are all non-public. */
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv4TailToGroups(value: string): string | null {
  const octets = value.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const numbers = octets.map(Number);
  if (numbers.some((part) => part < 0 || part > 255)) return null;
  return `${((numbers[0]! << 8) | numbers[1]!).toString(16)}:${((numbers[2]! << 8) | numbers[3]!).toString(16)}`;
}

/** Parses a canonical IPv6 literal into a bigint without performing DNS. */
function ipv6ToBigInt(input: string): bigint | null {
  let value = input.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!value || value.includes("%")) return null;
  if (value.includes(".")) {
    const cut = value.lastIndexOf(":");
    if (cut < 0) return null;
    const tail = ipv4TailToGroups(value.slice(cut + 1));
    if (!tail) return null;
    value = `${value.slice(0, cut)}:${tail}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((out, group) => (out << 16n) | BigInt(`0x${group}`), 0n);
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  if (value === null || value === 0n || value === 1n) return false;
  /* IPv4-compatible and IPv4-mapped literals must obey the IPv4 policy. */
  if (value >> 32n === 0n || value >> 32n === 0xffffn) {
    const tail = Number(value & 0xffffffffn);
    return isPublicIpv4([
      (tail >>> 24) & 255,
      (tail >>> 16) & 255,
      (tail >>> 8) & 255,
      tail & 255,
    ].join("."));
  }
  /* fc00::/7 (ULA), fe80::/10 (link-local), ff00::/8 (multicast),
   * 2001:db8::/32 (documentation), plus transition/tunnel ranges. */
  if ((value & (0xfe00n << 112n)) === (0xfc00n << 112n)) return false;
  if ((value & (0xffc0n << 112n)) === (0xfe80n << 112n)) return false;
  if ((value >> 120n) === 0xffn) return false;
  if ((value >> 96n) === 0x20010db8n) return false;
  if ((value >> 112n) === 0x2002n) return false;
  if ((value >> 96n) === 0x20010000n) return false;
  return true;
}

function isPublicIpAddress(address: string): boolean {
  const normalized = address.trim().replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

function forbiddenHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return !normalized
    || normalized === "localhost"
    || normalized === "metadata.google.internal"
    || FORBIDDEN_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function unsafeFeedTarget(): Error {
  /* Keep the reason stable and non-enumerating: it may be returned in a
   * public source-health response, so never include URL/host/DNS details. */
  return new Error("rss_target_not_allowed");
}

async function assertSafeFeedUrl(input: string, resolver: HostResolver = resolveHost): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw unsafeFeedTarget();
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw unsafeFeedTarget();
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (forbiddenHostname(hostname)) throw unsafeFeedTarget();
  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw unsafeFeedTarget();
    return url;
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw unsafeFeedTarget();
  }
  /* Require every resolved address to be public. Choosing only the first one
   * is unsafe on dual-stack hosts, and an empty answer is not fetchable. */
  if (!addresses.length || addresses.some((record) => !isPublicIpAddress(record.address))) {
    throw unsafeFeedTarget();
  }
  return url;
}

async function fetchSafeFeed(
  initialUrl: string,
  init: RequestInit,
  resolver: HostResolver = resolveHost,
  fetchImpl: FeedFetch = fetch as FeedFetch,
): Promise<Response> {
  let target = await assertSafeFeedUrl(initialUrl, resolver);
  for (let redirects = 0; redirects <= MAX_FEED_REDIRECTS; redirects++) {
    const response = await fetchImpl(target.toString(), { ...init, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    /* A redirect body is irrelevant and may hold a connection open. */
    void response.body?.cancel().catch(() => undefined);
    if (!location || redirects === MAX_FEED_REDIRECTS) throw unsafeFeedTarget();
    try {
      target = await assertSafeFeedUrl(new URL(location, target).toString(), resolver);
    } catch {
      throw unsafeFeedTarget();
    }
  }
  throw unsafeFeedTarget();
}

async function readFeedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FEED_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("rss_feed_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FEED_BYTES) {
        await reader.cancel();
        throw new Error("rss_feed_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/* Feed images arrive in several shapes. Relative and protocol-relative URLs
 * are resolved against the feed's own origin so they do not break inside the
 * client, and anything non-http(s) is dropped. Only the URLs the publisher
 * itself carried in the feed are used — no image is invented for items
 * without one. */
function resolveImageUrl(raw: string, baseUrl: string): string {
  const v = (raw || "").trim();
  if (!v) return "";
  try {
    const url = new URL(v, baseUrl || "https://example.invalid");
    return /^https?:$/.test(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function pickImage(it: Record<string, unknown>, baseUrl = ""): string | undefined {
  const enclosure = it["enclosure"] as Record<string, unknown> | undefined;
  if (
    enclosure &&
    typeof enclosure["@_url"] === "string" &&
    /^https?:\/\//.test(enclosure["@_url"] as string)
  ) {
    const resolved = resolveImageUrl(enclosure["@_url"], baseUrl);
    if (resolved) return resolved;
  }
  const mediaThumb = it["media:thumbnail"] as
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | undefined;
  const mt = Array.isArray(mediaThumb) ? mediaThumb[0] : mediaThumb;
  if (mt && typeof mt["@_url"] === "string") {
    const resolved = resolveImageUrl(mt["@_url"], baseUrl);
    if (resolved) return resolved;
  }
  const mediaContent = it["media:content"] as
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | undefined;
  const mc = Array.isArray(mediaContent) ? mediaContent[0] : mediaContent;
  if (mc && typeof mc["@_url"] === "string") {
    const resolved = resolveImageUrl(mc["@_url"], baseUrl);
    if (resolved) return resolved;
  }
  const desc = pickText(it["description"]) || pickText(it["content:encoded"]);
  if (desc) {
    const m = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
    const candidate = m ? m[1] : (desc.match(/src=["']([^"']+\.(?:jpg|jpeg|png|webp))/i)?.[1] ?? "");
    if (candidate) {
      const resolved = resolveImageUrl(candidate, baseUrl);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

/* Keep syndicated content to the permitted display shape: headline, short
 * snippet, named source and link back. We never fetch/publish article bodies. */
const NEWS_TITLE_MAX = 300;
const NEWS_SNIPPET_MAX = 280;

type FeedItem = {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  guid: string;
  thumbnail?: string;
  enclosure?: { url: string };
};

function parseFeed(xml: string, baseUrl = ""): FeedItem[] {
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
      const title = clean(pickText(it["title"])).slice(0, NEWS_TITLE_MAX);
      const description = clean(
        pickText(it["description"]) ||
          pickText(it["content:encoded"]) ||
          pickText(it["summary"]) ||
          "",
      ).slice(0, NEWS_SNIPPET_MAX);
      const link = safeUrl(pickLink(it["link"]) || pickText(it["guid"]));
      const rawDate =
        pickText(it["pubDate"]) ||
        pickText(it["published"]) ||
        pickText(it["dc:date"]) ||
        pickText(it["updated"]) ||
        "";
      const parsed = rawDate ? new Date(rawDate) : null;
      // Do not invent a current timestamp for undated items: recency ranking
      // must be based on publisher metadata, not fetch time.
      const pubDate = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : "";
      const guid = clean(pickText(it["guid"]).replace(/["'<>\\)\\]/g, "")) || link || title;
      const img = pickImage(it, baseUrl);
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
    const res = await fetchSafeFeed(src.url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept:
          "application/rss+xml, application/xml, application/atom+xml, text/xml, */*",
        "Accept-Language": "ar,en;q=0.8",
      },
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      throw new Error(`upstream ${res.status} for ${src.id}`);
    }
    const xml = await readFeedText(res);
    const items = parseFeed(xml, src.url).slice(0, 12);
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
    description: a.description.slice(0, NEWS_SNIPPET_MAX),
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
  // Always advertise the platform's own editorial pseudo-source. Third-party
  // RSS sources are listed only after a documented commercial review.
  sources.unshift({
    id: "admin",
    name: "تحرير المنصة",
    icon: "✍️",
    lang: "ar",
    cat: "egypt",
    color: "#a855f7",
  });
  res.json({
    status: "ok",
    sources,
    thirdPartyApprovedCount: sources.length - 1,
    policy: "third_party_rss_requires_commercial_redisplay_approval",
  });
});

type NewsFeed = { status: "ok"; items: FeedItem[]; meta: SourceMeta };

function newsDedupKey(item: FeedItem): string {
  const title = item.title.toLocaleLowerCase("ar")
    .replace(/[^\u0600-\u06ffa-z0-9]+/gi, "")
    .slice(0, 120);
  return title || item.link.toLowerCase().slice(0, 240);
}

/* Market relevance keeps a general feed (world/regional) from pushing genuine
 * EGX and economy stories off the homepage. It is a small, bounded boost — at
 * most six hours — so recency still dominates within the same relevance tier. */
const MARKET_RELEVANCE_RX =
  /البورصة|بورصة|أسهم|سهم|مؤشر|تداول|الجنيه|دولار|ذهب|تضخم|فائدة|البنك المركزي|اقتصاد|استثمار|نفط|بترول|egx|stock|shares|equity|market|inflation|interest rate|gold|brent|crude|currency|finance|bank|egypt/gi;

function marketRelevance(title: string): number {
  const unique = new Set((title.match(MARKET_RELEVANCE_RX) ?? []).map((m) => m.toLowerCase()));
  return Math.min(unique.size, 3);
}

function newsImportance(item: FeedItem): number {
  const title = item.title.toLowerCase();
  const breaking = /\b(breaking|urgent|alert)\b|عاجل|فوري/.test(title) ? 1_000_000_000_000 : 0;
  const published = Date.parse(item.pubDate);
  return breaking + marketRelevance(title) * 2 * 60 * 60 * 1000 + (Number.isFinite(published) ? published : 0);
}

/** Deduplicate across sources and rank newest/urgent items without copying text. */
function dedupeAndRankFeeds(feeds: NewsFeed[]): NewsFeed[] {
  const seen = new Set<string>();
  const normalized = feeds.map((feed) => ({
    ...feed,
    items: [...feed.items]
      .sort((a, b) => newsImportance(b) - newsImportance(a))
      .filter((item) => {
        const key = newsDedupKey(item);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 12),
  })).filter((feed) => feed.items.length > 0);
  return normalized.sort((a, b) => newsImportance(b.items[0]!) - newsImportance(a.items[0]!));
}

function rankedItemsFromFeeds(feeds: NewsFeed[]): RankedNewsItem[] {
  return feeds.flatMap((feed) => feed.items.map((item) => ({
    ...item,
    source: {
      id: feed.meta.id,
      name: feed.meta.name,
      icon: feed.meta.icon,
      lang: feed.meta.lang,
      cat: feed.meta.cat,
      color: feed.meta.color,
    },
    importance: newsImportance(item),
  }))).sort((a, b) => b.importance - a.importance);
}

type RankedNewsItem = FeedItem & {
  source: Pick<SourceMeta, "id" | "name" | "icon" | "lang" | "cat" | "color">;
  importance: number;
};

type NewsSnapshot = {
  status: "ok";
  /** `feeds` remains for server-side consumers such as the local AI. */
  feeds: NewsFeed[];
  /** Canonical, server-ranked presentation list for browser clients. */
  items: RankedNewsItem[];
  availability: "available" | "unavailable";
  reason?: "no_approved_sources" | "upstream_unavailable";
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
          /* Source health is public; never reflect an upstream redirect URL,
           * resolver failure, or internal transport detail to a visitor. */
          message: "upstream_unavailable",
        });
    });
    // Merge admin-authored content as a first-class feed.
    const custom = customArticlesFeed();
    if (custom.items.length > 0) feeds.unshift(custom);
    if (errors.length > 0) logger.warn({ errors }, "some news sources failed");
    const rankedFeeds = dedupeAndRankFeeds(feeds);
    const items = rankedItemsFromFeeds(rankedFeeds);
    const availability = items.length > 0 ? "available" : "unavailable";
    const data: NewsSnapshot = {
      status: "ok",
      feeds: rankedFeeds,
      items,
      availability,
      ...(availability === "unavailable"
        ? { reason: sources.length === 0 ? "no_approved_sources" as const : "upstream_unavailable" as const }
        : {}),
      errors,
    };
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
      message: "news source unavailable",
      items: [],
    });
  }
});

/* Test-only access to deterministic parsing/ranking logic; routes remain the
 * production interface. */
export const __newsTest = {
  parseFeed,
  newsDedupKey,
  newsImportance,
  dedupeAndRankFeeds,
  rankedItemsFromFeeds,
  isPublicIpAddress,
  assertSafeFeedUrl,
  fetchSafeFeed,
  readFeedText,
};

export default router;
