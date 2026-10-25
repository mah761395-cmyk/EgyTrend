/**
 * EgyTrend — data-layer health contract.
 *
 * The regression this guards against (2026-10-18/19): the deployed API answered
 * 200 but carried no data at all — /api/news reported
 * `availability: "unavailable", reason: "no_approved_sources"` with an empty
 * feed list, and /api/markets returned the "غير متاح" placeholder for every
 * source. Both are HTTP 200, so uptime pings cannot see them. This check
 * asserts the platform actually serves news items and real market sources.
 *
 * Usage:
 *   node scripts/check-data-layer.mjs [baseUrl]     # exit 0 healthy, 1 broken
 *   import { checkDataLayer } from "./check-data-layer.mjs"   (tests / CI)
 *
 * No credentials, no writes: only GET /api/health, /api/news, /api/markets.
 */

const PLACEHOLDER = "غير متاح";
const TIMEOUT_MS = Number(process.env.DATA_CHECK_TIMEOUT_MS || 45_000);

async function getJson(baseUrl, path) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/**
 * @param {string} baseUrl production or preview origin
 * @returns {Promise<{healthy: boolean, checks: Array<{name: string, ok: boolean, detail: string}>, summary: object}>}
 */
export async function checkDataLayer(baseUrl) {
  const checks = [];
  const summary = { baseUrl, checkedAt: new Date().toISOString() };
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail) });

  /* 1. the API answers at all */
  let health;
  try {
    health = await getJson(baseUrl, "/api/health");
    add("health: HTTP 200", health.status === 200, `status=${health.status}`);
    add("health: status ok", health.body?.status === "ok", `body.status=${health.body?.status}`);
  } catch (error) {
    add("health: reachable", false, `fetch failed: ${error?.message || error}`);
    return { healthy: false, checks, summary };
  }

  /* 2. news: feeds with items — the exact failure that shipped on Oct 18/19 */
  try {
    const news = await getJson(baseUrl, "/api/news");
    add("news: HTTP 200", news.status === 200, `status=${news.status}`);
    const b = news.body || {};
    add("news: not flagged unavailable", b.availability !== "unavailable", `availability=${b.availability ?? "-"}`);
    add("news: no no_approved_sources", b.reason !== "no_approved_sources", `reason=${b.reason ?? "-"}`);
    const feeds = Array.isArray(b.feeds) ? b.feeds : [];
    add("news: feeds present", feeds.length > 0, `feeds=${feeds.length}`);
    const items = feeds.reduce((n, f) => n + (Array.isArray(f?.items) ? f.items.length : 0), 0);
    add("news: items present", items > 0, `items=${items}`);
    summary.news = { feeds: feeds.length, items, availability: b.availability ?? null, reason: b.reason ?? null };
  } catch (error) {
    add("news: reachable", false, `fetch failed: ${error?.message || error}`);
  }

  /* 3. markets: real sources, not the placeholder */
  try {
    const markets = await getJson(baseUrl, "/api/markets");
    add("markets: HTTP 200", markets.status === 200, `status=${markets.status}`);
    const sources = markets.body?.sources || {};
    const keys = ["indices", "forex", "commodities", "crypto"];
    for (const key of keys) {
      const value = sources[key];
      add(`markets: ${key} source`, Boolean(value) && value !== PLACEHOLDER, `source=${value ?? "-"}`);
    }
    summary.markets = { sources };
  } catch (error) {
    add("markets: reachable", false, `fetch failed: ${error?.message || error}`);
  }

  return { healthy: checks.every((c) => c.ok), checks, summary };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
const { pathToFileURL } = await import("node:url");
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  const baseUrl = process.argv[2] || process.env.BASE_URL || "https://egy-trend.vercel.app";
  const { healthy, checks, summary } = await checkDataLayer(baseUrl);
  console.log(`EgyTrend data-layer check — ${baseUrl}`);
  for (const c of checks) console.log(`  ${c.ok ? "✔" : "✘"} ${c.name} — ${c.detail}`);
  console.log(healthy ? "RESULT: healthy" : "RESULT: BROKEN");
  if (process.env.DATA_CHECK_JSON) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.DATA_CHECK_JSON, JSON.stringify({ healthy, checks, summary }, null, 2));
  }
  process.exit(healthy ? 0 : 1);
}
