/**
 * EgyTrend — DATA-LAYER regression guard (node:test, no external deps).
 *
 * What broke in production on 2026-10-18/19 and shipped for ~20 hours:
 * the API answered HTTP 200 everywhere while carrying zero data —
 *   /api/news    → feeds: [], availability: "unavailable", reason: "no_approved_sources"
 *   /api/markets → every source was the "غير متاح" placeholder
 * Uptime pings stayed green, so nothing noticed. These tests pin the contract:
 * the checker must flag that exact shape as BROKEN and accept the healthy one.
 *
 * Deterministic: a local http server replays both recorded shapes. No network,
 * no database. Run:  node --test artifacts/api-server/test/data-layer.test.mjs
 * Live check:       node scripts/check-data-layer.mjs [baseUrl]
 */
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { checkDataLayer } from "../../../scripts/check-data-layer.mjs";

const BROKEN = {
  "/api/health": { status: "ok", ts: 1 },
  "/api/news": {
    status: "ok",
    feeds: [],
    items: [],
    availability: "unavailable",
    reason: "no_approved_sources",
    errors: [],
  },
  "/api/markets": {
    status: "ok",
    sources: { indices: "غير متاح", forex: "غير متاح", commodities: "غير متاح", crypto: "غير متاح" },
  },
};

const HEALTHY = {
  "/api/health": { status: "ok", ts: 1 },
  "/api/news": {
    status: "ok",
    feeds: [
      { id: "masrawy", status: "ok", items: [{ title: "خبر تجريبي 1" }, { title: "خبر تجريبي 2" }] },
      { id: "reuters", status: "ok", items: [{ title: "Sample wire item" }] },
    ],
    availability: "ok",
  },
  "/api/markets": {
    status: "ok",
    sources: { indices: "Yahoo Finance", forex: "Yahoo Finance", commodities: "Yahoo Finance", crypto: "CoinGecko" },
  },
};

function serve(fixture) {
  const server = createServer((req, res) => {
    const body = fixture[req.url];
    if (!body) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "error" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

let brokenUrl;
let healthyUrl;
let brokenServer;
let healthyServer;

before(async () => {
  ({ server: brokenServer, url: brokenUrl } = await serve(BROKEN));
  ({ server: healthyServer, url: healthyUrl } = await serve(HEALTHY));
});

after(() => {
  brokenServer?.close();
  healthyServer?.close();
});

test("the Oct 18/19 production shape is reported BROKEN (200-with-no-data)", async () => {
  const { healthy, checks } = await checkDataLayer(brokenUrl);
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  if (healthy) throw new Error("the broken fixture was reported healthy — the guard is worthless");
  for (const needle of [
    "news: not flagged unavailable",
    "news: no no_approved_sources",
    "news: feeds present",
    "markets: indices source",
    "markets: crypto source",
  ]) {
    if (!failed.includes(needle)) throw new Error(`expected the guard to fail "${needle}"; it failed: ${failed.join(", ")}`);
  }
});

test("a healthy deployment is reported healthy", async () => {
  const { healthy, checks } = await checkDataLayer(healthyUrl);
  const failed = checks.filter((c) => !c.ok);
  if (!healthy) throw new Error(`healthy fixture flagged broken: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`);
  if (checks.length < 8) throw new Error(`too few checks ran: ${checks.length}`);
});

test("an unreachable API is reported broken, never as a pass", async () => {
  healthyServer.close();
  const { healthy } = await checkDataLayer(healthyUrl).catch(() => ({ healthy: false }));
  if (healthy) throw new Error("unreachable server reported healthy");
  ({ server: healthyServer, url: healthyUrl } = await serve(HEALTHY));
});

test("news items are counted, not just feed entries", async () => {
  const partial = {
    ...HEALTHY,
    "/api/news": { status: "ok", feeds: [{ id: "empty", status: "ok", items: [] }], availability: "ok" },
  };
  const { server, url } = await serve(partial);
  try {
    const { healthy, checks } = await checkDataLayer(url);
    const itemsCheck = checks.find((c) => c.name === "news: items present");
    if (!itemsCheck || itemsCheck.ok) throw new Error("an all-empty feed list must fail the items check");
    if (healthy) throw new Error("feed-with-no-items must be reported broken");
  } finally {
    server.close();
  }
});
