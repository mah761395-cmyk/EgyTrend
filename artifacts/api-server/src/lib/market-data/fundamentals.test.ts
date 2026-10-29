import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryJsonCache } from "./cache";
import {
  buildDividendsResponse,
  buildValuationsResponse,
  matchEgxValuations,
  normalizeArabicName,
  parseEgxPeTable,
  parseYahooDividends,
  sanitizeEgxSymbol,
} from "./fundamentals";
import { EGX_STOCKS } from "./catalog";

/**
 * Contract for the secondary fundamentals layer (dividends + EGX P/E/DY):
 *  - parsers are pure and tested against REAL payload shapes captured live
 *    (Yahoo COMI.CA / FWRY.CA on 2026-10-29; the EGX MarketPECompanies page),
 *  - a real "no dividend in 12 months" (ttm 0) is distinct from a source
 *    failure (unavailable) — the two must never be conflated,
 *  - the EGX name matcher is conservative: generic words (بنك، تأمين،
 *    فنادق…) can never bind a pair on their own, and one page row can never
 *    feed two symbols,
 *  - the batch controllers are per-symbol fail-soft, cached, and deadline
 *    bounded so they can never take down the price screener path.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EGX_PE_HTML = readFileSync(join(here, "..", "..", "..", "testdata", "egx-market-pe.html"), "utf8");

const NOW = 1_761_650_000_000; // 2025-10-28T18:13:20Z

/* ── sanitizeEgxSymbol ── */

test("sanitizeEgxSymbol accepts EGX tickers and rejects everything else", () => {
  assert.equal(sanitizeEgxSymbol("COMI"), "COMI");
  assert.equal(sanitizeEgxSymbol(" comi "), "COMI");
  assert.equal(sanitizeEgxSymbol("BRK-B"), null, "dashes are not EGX tickers");
  assert.equal(sanitizeEgxSymbol("COMI;DROP TABLE"), null);
  assert.equal(sanitizeEgxSymbol(""), null);
  assert.equal(sanitizeEgxSymbol("A".repeat(17)), null, "over 16 chars is rejected");
});

/* ── parseYahooDividends ── */

test("parseYahooDividends: the real COMI.CA payload yields 6.0 EGP TTM", () => {
  // Captured live 2026-10-29 from
  // query1.finance.yahoo.com/v8/finance/chart/COMI.CA?range=1y&interval=1mo&events=dividends
  const payload = {
    chart: {
      result: [
        {
          meta: { symbol: "COMI.CA", currency: "EGP" },
          events: {
            dividends: {
              "1774994400": { amount: 6.0, date: 1775548800 },
            },
          },
        },
      ],
    },
  };
  const nowMs = Date.parse("2026-10-29T00:00:00Z");
  const parsed = parseYahooDividends(payload, nowMs);
  assert.ok(parsed);
  assert.equal(parsed.ttm, 6.0);
  assert.equal(parsed.lastAmount, 6.0);
  assert.equal(parsed.lastDate, 1774994400 * 1000, "lastDate is the ex-dividend date (ms)");
  assert.equal(parsed.count, 1);
});

test("parseYahooDividends: a chart result without any events key is a REAL zero (FWRY.CA shape)", () => {
  // FWRY.CA answered HTTP 200 with a chart result and NO events key at all:
  // the source says "no dividends in the window", which is an answer, not a failure.
  const payload = {
    chart: {
      result: [{ meta: { symbol: "FWRY.CA", currency: "EGP" } }],
    },
  };
  const parsed = parseYahooDividends(payload, Date.parse("2026-10-29T00:00:00Z"));
  assert.deepEqual(parsed, { ttm: 0, lastAmount: 0, lastDate: null, count: 0 });
});

test("parseYahooDividends: events sum over the window, newest is last", () => {
  const nowMs = Date.parse("2026-10-29T00:00:00Z");
  const payload = {
    chart: {
      result: [
        {
          events: {
            dividends: {
              "1761993600": { amount: 1.5, date: 1762598400 }, // Nov 2025
              "1769155200": { amount: 2.25, date: 1769760000 }, // Jan 2026
            },
          },
        },
      ],
    },
  };
  const parsed = parseYahooDividends(payload, nowMs)!;
  assert.equal(parsed.ttm, 3.75);
  assert.equal(parsed.count, 2);
  assert.equal(parsed.lastAmount, 2.25);
  assert.equal(parsed.lastDate, 1769155200 * 1000, "the newer event is last");
});

test("parseYahooDividends: events older than 12 months are excluded from TTM", () => {
  const nowMs = Date.parse("2026-10-29T00:00:00Z");
  const payload = {
    chart: {
      result: [
        {
          events: {
            dividends: {
              "1735689600": { amount: 9.9, date: 1736294400 }, // Jan 2025 — outside the window
              "1769155200": { amount: 1.0, date: 1769760000 },
            },
          },
        },
      ],
    },
  };
  const parsed = parseYahooDividends(payload, nowMs)!;
  assert.equal(parsed.ttm, 1.0, "only the in-window event counts");
  assert.equal(parsed.count, 1);
});

test("parseYahooDividends: unusable payloads (error bodies, garbage) return null, never a fake zero", () => {
  assert.equal(parseYahooDividends({ chart: { error: { code: "Not Found" } } }, NOW), null);
  assert.equal(parseYahooDividends({ chart: { result: [] } }, NOW), null);
  assert.equal(parseYahooDividends("rate limited", NOW), null);
  assert.equal(parseYahooDividends(null, NOW), null);
});

/* ── buildDividendsResponse ── */

type FakeHttpCalls = Array<{ method: "getJson" | "getText"; url: string }>;

/* Handlers may return a value or an Error (simulating a vendor failure). */
function fakeHttp(handlers: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getJson?: (url: string) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getText?: (url: string) => any;
}) {
  const calls: FakeHttpCalls = [];
  return {
    calls,
    async getJson(url: string): Promise<unknown> {
      calls.push({ method: "getJson", url });
      const value = handlers.getJson?.(url);
      if (value instanceof Error) throw value;
      return value;
    },
    async getText(url: string): Promise<string> {
      calls.push({ method: "getText", url });
      const value = handlers.getText?.(url);
      if (value instanceof Error) throw value;
      return value as string;
    },
  };
}

const COMI_PAYLOAD = {
  chart: { result: [{ meta: { symbol: "COMI.CA" }, events: { dividends: { "1774994400": { amount: 6.0, date: 1775548800 } } } }] },
};
const FWRY_PAYLOAD = { chart: { result: [{ meta: { symbol: "FWRY.CA" } }] } };

test("buildDividendsResponse: batch resolves every symbol, real zeros stay ok", async () => {
  const http = fakeHttp({
    getJson: (url) =>
      url.includes("COMI") ? COMI_PAYLOAD : url.includes("FWRY") ? FWRY_PAYLOAD : new Error("boom"),
  });
  const data = await buildDividendsResponse(["COMI", "FWRY", "BROKEN"], {
    http: http as never,
    cache: new MemoryJsonCache(),
    now: () => Date.parse("2026-10-29T00:00:00Z"),
  });
  assert.equal(data.status, "ok");
  assert.equal(data.currency, "EGP");
  assert.equal(data.windowDays, 365);
  const bySym = new Map(data.dividends.map((row) => [row.sym, row]));
  assert.equal(bySym.get("COMI")!.status, "ok");
  assert.equal(bySym.get("COMI")!.ttm, 6.0);
  assert.equal(bySym.get("FWRY")!.status, "ok", "no events key is a real answer, not unavailable");
  assert.equal(bySym.get("FWRY")!.ttm, 0);
  assert.equal(bySym.get("BROKEN")!.status, "unavailable", "a per-symbol failure is reported, not thrown");
});

test("buildDividendsResponse: per-symbol cache (6h) — a second batch does not re-fetch", async () => {
  const http = fakeHttp({ getJson: (url) => (url.includes("COMI") ? COMI_PAYLOAD : FWRY_PAYLOAD) });
  const cache = new MemoryJsonCache();
  const deps = { http: http as never, cache, now: () => Date.now() };
  const first = await buildDividendsResponse(["COMI", "FWRY"], deps);
  const second = await buildDividendsResponse(["COMI", "FWRY"], deps);
  assert.equal(http.calls.length, 2, "only the first batch touches the network");
  const comi = second.dividends.find((row) => row.sym === "COMI")!;
  assert.equal(comi.status, "ok");
  assert.equal(comi.ttm, 6.0);
  assert.equal(comi.fromCache, true);
  assert.equal(first.dividends[0].fromCache, false);
});

test("buildDividendsResponse: an unusable answer is not cached (next call retries)", async () => {
  let answer: unknown = { chart: { error: { code: "Nope" } } };
  const http = fakeHttp({ getJson: () => answer });
  const cache = new MemoryJsonCache();
  const deps = { http: http as never, cache, now: () => Date.now() };
  const first = await buildDividendsResponse(["COMI"], deps);
  assert.equal(first.dividends[0].status, "unavailable");
  answer = COMI_PAYLOAD;
  const second = await buildDividendsResponse(["COMI"], deps);
  assert.equal(second.dividends[0].status, "ok", "a bad answer must not poison the cache");
  assert.equal(second.dividends[0].ttm, 6.0);
  assert.equal(http.calls.length, 2);
});

test("buildDividendsResponse: serves the last good value stale during an outage", async () => {
  let fail = false;
  const http = fakeHttp({
    getJson: () => (fail ? new Error("upstream HTTP 500") : COMI_PAYLOAD),
  });
  const cache = new MemoryJsonCache();
  const deps = { http: http as never, cache, now: () => Date.now() };
  const fresh = await buildDividendsResponse(["COMI"], deps);
  assert.equal(fresh.dividends[0].stale, false);
  // Age the entry past the 6h TTL but inside the 24h stale window.
  const real = Date.now();
  await cache.set(
    "egytrend:market:dividends:v1:COMI",
    { value: { ttm: 6.0, lastAmount: 6.0, lastDate: 1774994400000, count: 1 }, cachedAt: real - 5 * 3_600_000, expiresAt: real - 1, staleUntil: real + 19 * 3_600_000 },
  );
  fail = true;
  const stale = await buildDividendsResponse(["COMI"], deps);
  assert.equal(stale.dividends[0].status, "ok");
  assert.equal(stale.dividends[0].ttm, 6.0);
  assert.equal(stale.dividends[0].stale, true, "outage data is served clearly stale");
});

test("buildDividendsResponse: deadline bounds the batch; late symbols come back unavailable", async () => {
  // Monotonic fake clock: each tick advances 1s; the COMI vendor call burns
  // 60s of it, so the second symbol is already past the 45s deadline.
  let clockMs = 0;
  const now = () => (clockMs += 1_000);
  const http = fakeHttp({
    getJson: async (url) => {
      if (url.includes("COMI")) {
        for (let i = 0; i < 60; i += 1) now(); // a very slow vendor
        return COMI_PAYLOAD;
      }
      throw new Error("slow");
    },
  });
  const data = await buildDividendsResponse(["COMI", "NEVER"], {
    http: http as never,
    cache: new MemoryJsonCache(),
    now,
    deadlineMs: 45_000,
  });
  const bySym = new Map(data.dividends.map((row) => [row.sym, row]));
  assert.equal(bySym.get("COMI")!.status, "ok");
  assert.equal(bySym.get("NEVER")!.status, "unavailable", "no unbounded vendor time in a serverless function");
  assert.equal(http.calls.length, 1, "the late symbol is never even requested");
});

test("buildDividendsResponse: duplicate symbols are requested once", async () => {
  const http = fakeHttp({ getJson: () => COMI_PAYLOAD });
  const data = await buildDividendsResponse(["COMI", "comi", "COMI"], { http: http as never, cache: new MemoryJsonCache(), now: () => NOW });
  assert.equal(data.dividends.length, 1);
  assert.equal(http.calls.length, 1);
});

/* ── parseEgxPeTable ── */

test("parseEgxPeTable: the real page structure parses to company rows only", () => {
  const rows = parseEgxPeTable(EGX_PE_HTML);
  const byName = new Map(rows.map((row) => [row.name, row]));
  // The live values, straight from the page:
  assert.deepEqual(byName.get("مجموعة طلعت مصطفى القابضة"), { name: "مجموعة طلعت مصطفى القابضة", pe: 9.35, dy: 0.36 });
  assert.deepEqual(byName.get("البنك التجاري الدولي -مصر (سى اى بى )"), { name: "البنك التجاري الدولي -مصر (سى اى بى )", pe: 5.08, dy: 4.89 });
  assert.deepEqual(byName.get("المصرية للاتصالات"), { name: "المصرية للاتصالات", pe: 9.56, dy: 1.19 });
  assert.equal(byName.get("ابن سينا فارما")!.dy, 1.29);
  // Header, average and fund rows are never published as companies:
  assert.ok(!byName.has("اسم الشركة"));
  assert.ok(!byName.has("متوسط"), "the page's own average row is excluded");
  for (const row of rows) {
    assert.ok(!/وثائق|صندوق|ETF/i.test(row.name), `fund row leaked: ${row.name}`);
  }
  // CIB-currency duplicates collapse to the first (EGP) occurrence:
  const saudi = rows.filter((row) => row.name.startsWith("السعودية المصرية"));
  assert.equal(saudi.length, 1, "the '$' duplicate row is de-duplicated");
  assert.equal(saudi[0].pe, 17.85);
  // Integer P/E cells (e.g. "16") parse too:
  assert.equal(byName.get("الاستثمار العقاري العربي - اليكو")!.pe, 16);
  assert.ok(rows.length > 60, `expected the full company list, got ${rows.length}`);
});

test("parseEgxPeTable: empty or unrelated HTML yields zero rows (never partial garbage)", () => {
  assert.deepEqual(parseEgxPeTable(""), []);
  assert.deepEqual(parseEgxPeTable("<html><body>جاري التحديث ...</body></html>"), [], "the JS-loading prices page shape parses to nothing");
});

test("parseEgxPeTable: entities are decoded in cell text", () => {
  const html = `<table><tr><td>الاولى &amp; الثانية للخدمات</td><td>12.5</td><td>1.5</td></tr></table>`;
  const rows = parseEgxPeTable(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "الاولى & الثانية للخدمات");
  assert.equal(rows[0].pe, 12.5);
});

/* ── normalizeArabicName ── */

test("normalizeArabicName unifies Arabic variants and strips punctuation", () => {
  assert.equal(normalizeArabicName("أبو ظبي"), "ابو ظبي");
  assert.equal(normalizeArabicName("أبوظبي"), "ابوظبي");
  assert.equal(normalizeArabicName("السويدى اليكتريك"), "السويدي اليكتريك");
  assert.equal(normalizeArabicName("مصر للاسمنت - قنا"), "مصر للاسمنت قنا");
  assert.equal(normalizeArabicName("Taaleem Mgmt"), "taaleem mgmt");
  assert.equal(normalizeArabicName("السعودية المصرية للاستثمار والتمويل $"), normalizeArabicName("السعودية المصرية للاستثمار والتمويل"));
  // …but genuinely different spellings stay different (no false merges).
  assert.notEqual(normalizeArabicName("مصرف أبو ظبي الأسلامي"), normalizeArabicName("مصرف ابوظبي الإسلامي"));
});

/* ── matchEgxValuations ── */

function matchedBySym(rows: ReturnType<typeof parseEgxPeTable>): Map<string, { pe: number; dy: number; egxName: string }> {
  const out = new Map<string, { pe: number; dy: number; egxName: string }>();
  for (const item of matchEgxValuations(rows, EGX_STOCKS.map((item) => ({ sym: item.sym, name: item.name })))) {
    out.set(item.sym, { pe: item.row.pe, dy: item.row.dy, egxName: item.row.name });
  }
  return out;
}

test("matchEgxValuations: the curated identities match the right page rows (live values)", () => {
  const rows = parseEgxPeTable(EGX_PE_HTML);
  const matched = matchedBySym(rows);
  const expect: Array<[string, number, number]> = [
    ["TMGH", 9.35, 0.36],
    ["COMI", 5.08, 4.89],
    ["ETEL", 9.56, 1.19],
    ["FWRY", 18.9, 0],
    ["ORWE", 6.76, 6.52],
    ["PHDC", 7.56, 0],
    ["ASCM", 6.96, 0],
    ["ABUK", 12.3, 2.52],
    ["CIEB", 4.02, 14.83],
    ["ADIB", 5.54, 0],
    ["POUL", 5.84, 3.5],
    ["CLHO", 20.93, 0],
    ["EFID", 13.93, 4.82],
    ["JUFO", 17.94, 1.72],
    ["OLFI", 9.06, 9.05],
    ["MASR", 3.82, 2.3],
    ["HELI", 18.84, 0],
    ["CCAP", 0, 0],
    ["OCDI", 6.89, 0],
    ["AMER", 18.74, 0],
    ["SKPC", 14.65, 0],
    ["EDBE", 4.19, 0],
    ["SWDY", 12.21, 1.69],
    ["MCQE", 6.19, 6.06],
    ["ACGC", 7.23, 0],
    ["ISPH", 10.64, 1.29],
    ["EFIH", 30.92, 0.54],
    ["SPIN", 0, 0],
    ["KABO", 24.5, 0],
    ["AMOC", 10.86, 3.07],
    ["DOMT", 39.24, 0],
  ];
  for (const [sym, pe, dy] of expect) {
    assert.ok(matched.has(sym), `${sym} must match its EGX page row`);
    assert.equal(matched.get(sym)!.pe, pe, `${sym} P/E`);
    assert.equal(matched.get(sym)!.dy, dy, `${sym} DY`);
  }
});

test("matchEgxValuations: near-name traps never match (a wrong P/E is worse than none)", () => {
  const rows = parseEgxPeTable(EGX_PE_HTML);
  const matched = matchedBySym(rows);
  // Each of these has a tempting page row that belongs to ANOTHER company:
  const traps: Array<[string, string]> = [
    ["SFAP", "الدلتا للتأمين"],        // "مصر للتأمين" ≠ Delta Tameen
    ["HELB", "مصر للفنادق"],           // "هيلنان للفنادق" ≠ Egypt Hotels
    ["SCOM", "سيدى كرير للبتروكيماويات"], // Sid-Krir petrochems is SKPC's row
    ["ARPH", "EAC"],                   // "العربية للأوراق" ≠ EAC brokerage
    ["EAST", "الشرقية - ايسترن كومباني"], // "الشرق للدخان" ≠ Eastern Co.
    ["PHAR", "ايبيكو"],                // "إيبي فارما" ≠ EID/Abico
    ["EGCH", "جورميه"],                // "إيجيبت للصناعات الكيماوية" ≠ Gourmet
    ["KAHA", "الدولية للمحاصيل"],      // "قها للمحاصيل" ≠ International Crops
    ["OTLQ", "نايل سات"],               // "أوراسكوم TMT" ≠ NileSat… (neither is on the page)
    ["GBCO", "ام.م جروب"],             // "جي بي" ≠ AMM Group
    ["AMCO", "طاقة عربية"],            // "أموك للطاقة" ≠ Energy Arab
    ["ARCO", "كرستمارك"],               // "العربية للمقاولات" ≠ Crestmark
  ];
  for (const [sym, pageFragment] of traps) {
    const entry = matched.get(sym);
    assert.ok(!entry || !entry.egxName.includes(pageFragment), `${sym} must not take the "${pageFragment}" row`);
  }
  assert.ok(!matched.has("KAHA"), "قها للمحاصيل has no page row of its own");
});

test("matchEgxValuations: one page row can never feed two symbols", () => {
  const rows = parseEgxPeTable(EGX_PE_HTML);
  const pairs = matchEgxValuations(rows, EGX_STOCKS.map((item) => ({ sym: item.sym, name: item.name })));
  const rowNames = new Set(pairs.map((item) => normalizeArabicName(item.row.name)));
  assert.equal(rowNames.size, pairs.length, "page rows are unique per assignment");
  const syms = new Set(pairs.map((item) => item.sym));
  assert.equal(syms.size, pairs.length, "symbols are unique per assignment");
  // The Sid-Krir petrochemicals row goes to SKPC (3 token hits), not SCOM (2).
  const skpc = pairs.find((item) => item.sym === "SKPC")!;
  assert.equal(skpc.row.pe, 14.65);
  assert.ok(!pairs.some((item) => item.sym === "SCOM"), "SCOM stays honestly unmatched");
});

test("matchEgxValuations: a ticker written inside the page name is an explicit match", () => {
  const rows = parseEgxPeTable(EGX_PE_HTML);
  const pairs = matchEgxValuations(rows, [{ sym: "SCCD", name: "" }]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].row.pe, 11.09, "the SCCD row (… العقاري SCCD) matches by ticker");
});

test("matchEgxValuations: symbols without Arabic names never match on filler overlap", () => {
  const rows = parseEgxPeTable(EGX_PE_HTML);
  // A non-curated screener symbol has no Arabic name: only an explicit ticker
  // can bind it, and generic words must not.
  const pairs = matchEgxValuations(rows, [
    { sym: "AM", name: "" },
    { sym: "XXXX", name: "" },
  ]);
  assert.equal(pairs.length, 0);
});

/* ── buildValuationsResponse ── */

test("buildValuationsResponse: matched rows carry values, names and honest coverage", async () => {
  const http = fakeHttp({ getText: () => EGX_PE_HTML });
  const data = await buildValuationsResponse([], { http: http as never, cache: new MemoryJsonCache(), now: () => NOW });
  assert.equal(data.status, "ok");
  assert.equal(data.stale, false);
  assert.match(data.source, /البورصة المصرية/);
  assert.match(data.coverage, /تغطية جزئية/, "the partial coverage must be stated, not hidden");
  assert.ok(data.totalRows > 60);
  assert.ok(data.matchedCount > 25, `expected most curated identities to match, got ${data.matchedCount}`);
  const bySym = new Map(data.rows.map((row) => [row.sym, row]));
  assert.equal(bySym.get("TMGH")!.pe, 9.35);
  assert.equal(bySym.get("TMGH")!.dy, 0.36);
  assert.equal(bySym.get("TMGH")!.egxName, "مجموعة طلعت مصطفى القابضة");
  for (const row of data.rows) {
    assert.ok(Number.isFinite(row.pe) && row.pe >= 0, "P/E stays a real number");
    assert.ok(Number.isFinite(row.dy) && row.dy >= 0, "DY stays a real number");
  }
});

test("buildValuationsResponse: only requested symbols are matched", async () => {
  const http = fakeHttp({ getText: () => EGX_PE_HTML });
  const data = await buildValuationsResponse(["TMGH", "COMI"], { http: http as never, cache: new MemoryJsonCache(), now: () => NOW });
  assert.deepEqual(data.rows.map((row) => row.sym).sort(), ["COMI", "TMGH"]);
});

test("buildValuationsResponse: the parsed page is cached (one fetch per TTL)", async () => {
  const http = fakeHttp({ getText: () => EGX_PE_HTML });
  const cache = new MemoryJsonCache();
  const deps = { http: http as never, cache, now: () => NOW };
  await buildValuationsResponse([], deps);
  await buildValuationsResponse(["TMGH"], deps);
  assert.equal(http.calls.length, 1, "second call is a cache hit");
});

test("buildValuationsResponse: an outage serves the last good page, clearly stale", async () => {
  let fail = false;
  const http = fakeHttp({ getText: () => (fail ? new Error("upstream HTTP 503") : EGX_PE_HTML) });
  const cache = new MemoryJsonCache();
  const deps = { http: http as never, cache, now: () => Date.now() };
  const fresh = await buildValuationsResponse(["TMGH"], deps);
  assert.equal(fresh.stale, false);
  const rows = fresh.rows.length;
  const real = Date.now();
  await cache.set(
    "egytrend:market:egx-pe:v1",
    {
      value: parseEgxPeTable(EGX_PE_HTML),
      cachedAt: real - 5 * 3_600_000,
      expiresAt: real - 1,
      staleUntil: real + 19 * 3_600_000,
    },
  );
  fail = true;
  const stale = await buildValuationsResponse(["TMGH"], deps);
  assert.equal(stale.stale, true);
  assert.equal(stale.rows.length, rows, "the last good table is still served");
  assert.equal(stale.rows.find((row) => row.sym === "TMGH")!.pe, 9.35);
});

test("buildValuationsResponse: zero parsed rows is a failure (never an empty success)", async () => {
  const http = fakeHttp({ getText: () => "<html>جاري التحديث ...</html>" });
  await assert.rejects(
    () => buildValuationsResponse([], { http: http as never, cache: new MemoryJsonCache(), now: () => NOW }),
  );
});
