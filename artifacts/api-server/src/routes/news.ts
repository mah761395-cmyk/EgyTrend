import { Router, type IRouter } from "express";
import { XMLParser } from "fast-xml-parser";
import { logger } from "../lib/logger";

const router: IRouter = Router();

type SourceMeta = {
  id: string;
  name: string;
  icon: string;
  lang: "ar" | "en";
  cat: "egypt" | "global" | "stocks" | "crypto";
  color: string;
  url: string;
};

const SOURCES: Record<string, SourceMeta> = {
  youm7: {
    id: "youm7",
    name: "اليوم السابع",
    icon: "📰",
    lang: "ar",
    cat: "egypt",
    color: "#0ea5e9",
    url: "https://www.youm7.com/rss/SectionRss?SectionID=297",
  },
  masrawy: {
    id: "masrawy",
    name: "مصراوي",
    icon: "📱",
    lang: "ar",
    cat: "egypt",
    color: "#10b981",
    url: "https://www.masrawy.com/rss/economy",
  },
  amwal: {
    id: "amwal",
    name: "أموال الغد",
    icon: "💰",
    lang: "ar",
    cat: "egypt",
    color: "#7c3aed",
    url: "https://amwalalghad.com/category/news/feed",
  },
  elwatan: {
    id: "elwatan",
    name: "الوطن",
    icon: "🗞️",
    lang: "ar",
    cat: "egypt",
    color: "#b45309",
    url: "https://news.google.com/rss/search?q=site:elwatannews.com+%D8%A7%D9%82%D8%AA%D8%B5%D8%A7%D8%AF&hl=ar&gl=EG&ceid=EG:ar",
  },
  shorouk: {
    id: "shorouk",
    name: "الشروق",
    icon: "📑",
    lang: "ar",
    cat: "egypt",
    color: "#dc2626",
    url: "https://news.google.com/rss/search?q=site:shorouknews.com+%D8%A7%D9%82%D8%AA%D8%B5%D8%A7%D8%AF&hl=ar&gl=EG&ceid=EG:ar",
  },
  masrawy: {
    id: "masrawy",
    name: "مصراوي",
    icon: "📱",
    lang: "ar",
    cat: "egypt",
    color: "#10b981",
    url: "https://news.google.com/rss/search?q=site:masrawy.com+%D8%A7%D9%82%D8%AA%D8%B5%D8%A7%D8%AF&hl=ar&gl=EG&ceid=EG:ar",
  },
  alarabiya: {
    id: "alarabiya",
    name: "العربية",
    icon: "🌍",
    lang: "ar",
    cat: "global",
    color: "#c2410c",
    url: "https://news.google.com/rss/search?q=site:alarabiya.net+%D8%A3%D8%B3%D9%88%D8%A7%D9%82&hl=ar&gl=SA&ceid=SA:ar",
  },
  aljazeera: {
    id: "aljazeera",
    name: "الجزيرة",
    icon: "🌐",
    lang: "ar",
    cat: "global",
    color: "#f59e0b",
    url: "https://www.aljazeera.net/aljazeerarss/2bb46c0f-92a5-44a2-8a78-d5d6814ff139/8c5dc74d-1e01-44c0-aac7-ff320be01f86",
  },
  bbcar: {
    id: "bbcar",
    name: "BBC عربي",
    icon: "🔵",
    lang: "ar",
    cat: "global",
    color: "#e2001a",
    url: "https://feeds.bbci.co.uk/arabic/business/rss.xml",
  },
  alain: {
    id: "alain",
    name: "العين",
    icon: "👁️",
    lang: "ar",
    cat: "global",
    color: "#6366f1",
    url: "https://news.google.com/rss/search?q=site:al-ain.com+%D8%A7%D9%82%D8%AA%D8%B5%D8%A7%D8%AF&hl=ar&gl=AE&ceid=AE:ar",
  },
  egnews: {
    id: "egnews",
    name: "أخبار مصر",
    icon: "🇪🇬",
    lang: "ar",
    cat: "egypt",
    color: "#22c55e",
    url: "https://news.google.com/rss/search?q=%D8%A7%D9%82%D8%AA%D8%B5%D8%A7%D8%AF+%D9%85%D8%B5%D8%B1+%D8%A8%D9%88%D8%B1%D8%B5%D8%A9&hl=ar&gl=EG&ceid=EG:ar",
  },
  reuters: {
    id: "reuters",
    name: "Reuters Business",
    icon: "🔴",
    lang: "en",
    cat: "global",
    color: "#ff8c00",
    url: "https://news.google.com/rss/search?q=when:24h+allinurl:reuters.com/business&hl=en-US&gl=US&ceid=US:en",
  },
  cnbc: {
    id: "cnbc",
    name: "CNBC",
    icon: "📊",
    lang: "en",
    cat: "global",
    color: "#0080ff",
    url: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  },
  yahoo: {
    id: "yahoo",
    name: "Yahoo Finance",
    icon: "🟣",
    lang: "en",
    cat: "global",
    color: "#7e22ce",
    url: "https://finance.yahoo.com/news/rssindex",
  },
  marketwatch: {
    id: "marketwatch",
    name: "MarketWatch",
    icon: "📈",
    lang: "en",
    cat: "stocks",
    color: "#1a7f37",
    url: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
  },
  investing: {
    id: "investing",
    name: "Investing.com",
    icon: "💹",
    lang: "en",
    cat: "global",
    color: "#ef4444",
    url: "https://www.investing.com/rss/news_25.rss",
  },
  ft: {
    id: "ft",
    name: "Financial Times",
    icon: "🟫",
    lang: "en",
    cat: "stocks",
    color: "#9d6e3f",
    url: "https://www.ft.com/markets?format=rss",
  },
  coindesk: {
    id: "coindesk",
    name: "CoinDesk",
    icon: "₿",
    lang: "en",
    cat: "crypto",
    color: "#f59e0b",
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/",
  },
  cointelegraph: {
    id: "cointelegraph",
    name: "CoinTelegraph",
    icon: "🔗",
    lang: "en",
    cat: "crypto",
    color: "#0891b2",
    url: "https://cointelegraph.com/rss",
  },
};

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
      const link = pickLink(it["link"]) || pickText(it["guid"]);
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
      const guid = pickText(it["guid"]) || link || title;
      const img = pickImage(it);
      return {
        title,
        link,
        description,
        pubDate,
        guid,
        ...(img ? { thumbnail: img, enclosure: { url: img } } : {}),
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
const FETCH_TIMEOUT_MS = 9000;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) EgyTrend/1.0";

async function fetchSource(src: SourceMeta): Promise<{
  status: "ok";
  items: FeedItem[];
  meta: SourceMeta;
}> {
  const cached = CACHE.get(src.id);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

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
    if (items.length > 0) CACHE.set(src.id, { ts: Date.now(), data });
    return data;
  } finally {
    clearTimeout(t);
  }
}

router.get("/news/sources", (_req, res) => {
  res.json({
    status: "ok",
    sources: Object.values(SOURCES).map((s) => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      lang: s.lang,
      cat: s.cat,
      color: s.color,
    })),
  });
});

router.get("/news", async (req, res) => {
  const sourceId = String(req.query["source"] || "").trim();

  if (!sourceId || sourceId === "all") {
    const settled = await Promise.allSettled(
      Object.values(SOURCES).map((s) => fetchSource(s)),
    );
    const feeds = settled
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<{
          status: "ok";
          items: FeedItem[];
          meta: SourceMeta;
        }> => r.status === "fulfilled",
      )
      .map((r) => r.value);
    const errors = settled
      .map((r, i) => ({
        r,
        id: Object.values(SOURCES)[i]?.id || "?",
      }))
      .filter((x) => x.r.status === "rejected")
      .map((x) => ({
        source: x.id,
        message: (x.r as PromiseRejectedResult).reason?.message || "error",
      }));
    if (errors.length > 0) {
      logger.warn({ errors }, "some news sources failed");
    }
    res.json({ status: "ok", feeds, errors });
    return;
  }

  const src = SOURCES[sourceId];
  if (!src) {
    res.status(404).json({ status: "error", message: "unknown source" });
    return;
  }
  try {
    const data = await fetchSource(src);
    res.json(data);
  } catch (err) {
    logger.warn(
      { err, source: sourceId },
      "failed to fetch news source",
    );
    res.status(502).json({
      status: "error",
      message: (err as Error).message || "fetch failed",
      items: [],
    });
  }
});

export default router;
