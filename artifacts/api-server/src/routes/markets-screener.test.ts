import assert from "node:assert/strict";
import test from "node:test";
import { MemoryJsonCache } from "../lib/market-data/cache";
import { EGX_STOCKS } from "../lib/market-data/catalog";
import { TradingViewScannerProvider, type TvScanRow } from "../lib/market-data/providers";
import { MarketDataService } from "../lib/market-data/service";
import type { ProviderDescriptor } from "../lib/market-data/types";
import { egxScanToStockSnapshot } from "./markets";

/* The screener bug that shipped as "37 stocks": the old build priced only
 * the curated catalog and silently dropped every curated symbol the vendor
 * had no listing row for. These tests pin the replacement contract:
 *  - the source's full priced equity list becomes the row set,
 *  - curated symbols keep their Arabic identity, others use source labels,
 *  - curated symbols with no source row stay visible as explicit no-data,
 *  - fields the source does not provide stay absent (never invented),
 *  - index rows never mix into the equity screener. */

const NOW = 1_761_000_000_000;

function row(partial: Partial<TvScanRow> & { sym: string }): TvScanRow {
  return {
    type: "stock",
    description: partial.sym,
    close: 100,
    change: 2.5,
    changeAbs: 2.5,
    open: 98,
    high: 103,
    low: 97,
    volume: 1_000_000,
    marketCap: 2_500_000_000,
    sector: "Financials",
    amount: undefined,
    pe: undefined,
    divYield: undefined,
    eps: undefined,
    high52w: undefined,
    low52w: undefined,
    ...partial,
  };
}

const curated = EGX_STOCKS;

test("screener keeps every priced equity row the source reports", () => {
  // 10 curated symbols + 30 non-catalog symbols, in market-cap order.
  const scan = {
    fetchedAt: NOW,
    stale: false,
    rows: [
      ...curated.slice(0, 10).map((definition, index) =>
        row({
          sym: definition.sym,
          close: 100 + index,
          description: `EGX:${definition.sym}`,
          marketCap: (60 - index) * 1_000_000_000,
        }),
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        row({
          sym: `NEWT${String(index).padStart(2, "0")}`,
          description: `New Egyptian Company ${index}`,
          close: 50 + index,
          change: index % 2 ? 1 : -1,
          changeAbs: index % 2 ? 0.5 : -0.5,
        }),
      ),
    ],
  };

  const snapshot = egxScanToStockSnapshot(scan);

  assert.equal(snapshot.unavailable, false);
  assert.equal(snapshot.pricedCount, 40);
  // 40 priced rows + the 44 curated symbols the scan did not report, kept
  // visible as explicit no-data rows (that visibility is the bug fix).
  assert.equal(snapshot.stocks.length, 40 + (curated.length - 10));
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.source, "TradingView Scanner");

  // Curated rows keep the catalog's Arabic identity…
  const first = snapshot.stocks.find((stock) => stock.sym === curated[0].sym)!;
  assert.equal(first.name, curated[0].name);
  assert.equal(first.sector, curated[0].sector);
  assert.equal(first.instrumentId, `stock:egx:${curated[0].sym}`);
  // …and every field the source provided is carried over, scaled for UI.
  assert.equal(first.mktCapM, 60_000); // 60 * 1e9 EGP -> 60 000 millions
  assert.equal(first.vol, 1_000_000);
  assert.equal(first.high, 103);
  assert.equal(first.low, 97);
  assert.equal(first.open, 98);
  assert.equal(first.prevClose, first.price! - 2.5);

  // Non-catalog rows use the source's own labels — no invented Arabic names.
  const extra = snapshot.stocks.find((stock) => stock.sym === "NEWT00")!;
  assert.equal(extra.name, "New Egyptian Company 0");
  assert.equal(extra.sector, "Financials");
  assert.equal(extra.price, 50);
  assert.equal(extra.chgPct, -1);

  // Priced rows only: every priced row carries a price the source reported,
  // and no-data rows carry none (they are the explicit remainder).
  for (const stock of snapshot.stocks) {
    if (stock.noData) {
      assert.equal(stock.price, undefined, `no-data row ${stock.sym} must stay unpriced`);
    } else {
      assert.ok(stock.price && stock.price > 0, `row ${stock.sym} must be priced`);
    }
  }
});

test("index rows and unpriced rows never enter the equity screener", () => {
  const scan = {
    fetchedAt: NOW,
    stale: false,
    rows: [
      row({ sym: "EGX30", type: "index", close: 31_000, description: "EGX30 Index" }),
      row({ sym: "EGX70", type: "index", close: 3_900, description: "EGX70 Index" }),
      row({ sym: "SUSP0", description: "Suspended company", close: 0, change: undefined, changeAbs: undefined, open: undefined, high: undefined, low: undefined, volume: undefined, marketCap: undefined }),
      row({ sym: "PRICED", close: 42, description: "Priced company" }),
    ],
  };

  const snapshot = egxScanToStockSnapshot(scan);

  const syms = snapshot.stocks.map((stock) => stock.sym);
  assert.ok(!syms.includes("EGX30"), "index row must not appear as a stock");
  assert.ok(!syms.includes("EGX70"), "index row must not appear as a stock");
  assert.ok(!syms.includes("SUSP0"), "unpriced row has no source data");
  assert.ok(syms.includes("PRICED"));
  assert.equal(snapshot.pricedCount, 1);
});

test("curated symbols without a source row stay listed, explicitly unpriced", () => {
  // Only 5 of the 54 curated symbols have a row; the other 49 must remain
  // visible as no-data rows instead of vanishing (the "37" bug).
  const scan = {
    fetchedAt: NOW,
    stale: false,
    rows: curated.slice(0, 5).map((definition, index) =>
      row({ sym: definition.sym, close: 100 + index, description: `EGX:${definition.sym}` }),
    ),
  };

  const snapshot = egxScanToStockSnapshot(scan);

  assert.equal(snapshot.stocks.length, 54);
  assert.equal(snapshot.pricedCount, 5);
  assert.equal(snapshot.unavailable, false);

  const missing = snapshot.stocks.filter((stock) => stock.noData === true);
  assert.equal(missing.length, 49);
  for (const stock of missing) {
    const definition = curated.find((item) => item.sym === stock.sym)!;
    assert.ok(definition, `no-data row ${stock.sym} must be a curated symbol`);
    assert.equal(stock.name, definition.name);
    assert.equal(stock.sector, definition.sector);
    assert.equal(stock.instrumentId, definition.id);
    assert.equal(stock.price, undefined, "no-data rows must not invent a price");
    assert.equal(stock.chg, undefined);
    assert.equal(stock.chgPct, undefined);
    assert.equal(stock.vol, undefined);
  }
  // No data source: the state is unknown, never faked as live.
  assert.notEqual(snapshot.state, "live");
});

test("a completely empty scan is a truthful unavailable state", () => {
  const snapshot = egxScanToStockSnapshot({ fetchedAt: NOW, stale: false, rows: [] });

  assert.equal(snapshot.unavailable, true);
  assert.equal(snapshot.pricedCount, 0);
  assert.equal(snapshot.stocks.length, curated.length, "all curated symbols stay visible");
  assert.ok(snapshot.stocks.every((stock) => stock.noData === true));
  assert.equal(snapshot.source, "غير متاح");
  assert.equal(snapshot.tvSymbols.length, 0);
});

test("change fields are derived transparently or omitted, never faked as zero", () => {
  const scan = {
    fetchedAt: NOW,
    stale: false,
    rows: [
      // Source supplies both percent and absolute change.
      row({ sym: "BOTH", close: 110, change: 4.545, changeAbs: 4.75 }),
      // Source supplies only the absolute change: percent is derived exactly.
      row({ sym: "ABS_ONLY", close: 110, change: undefined, changeAbs: 10 }),
      // Source supplies neither: both fields stay absent.
      row({ sym: "NEITHER", close: 110, change: undefined, changeAbs: undefined }),
    ],
  };

  const snapshot = egxScanToStockSnapshot(scan);
  const bySym = new Map(snapshot.stocks.map((stock) => [stock.sym, stock]));

  assert.equal(bySym.get("BOTH")!.chg, 4.75);
  assert.equal(bySym.get("BOTH")!.chgPct, 4.545);
  assert.equal(bySym.get("BOTH")!.prevClose, 105.25);

  assert.equal(bySym.get("ABS_ONLY")!.chg, 10);
  assert.equal(bySym.get("ABS_ONLY")!.chgPct, (10 / 100) * 100);
  assert.equal(bySym.get("ABS_ONLY")!.prevClose, 100);

  assert.equal(bySym.get("NEITHER")!.chg, undefined);
  assert.equal(bySym.get("NEITHER")!.chgPct, undefined);
  assert.equal(bySym.get("NEITHER")!.prevClose, undefined);
});

/* ── Extended columns: present when the source publishes them, absent (never
 * zero) when it does not ── */

test("extended scanner columns flow into the screener row by row", () => {
  const scan = {
    fetchedAt: NOW,
    stale: false,
    rows: [
      row({
        sym: "COMI",
        close: 12.5,
        change: -1.57,
        changeAbs: -0.2,
        amount: 12_500_000,
        pe: 18.4,
        divYield: 2.1,
        eps: 0.68,
        high52w: 15.2,
        low52w: 9.9,
      }),
      // Same market, extended pass published nothing for this row.
      row({ sym: "ABUK" }),
    ],
  };

  const snapshot = egxScanToStockSnapshot(scan);
  const bySym = new Map(snapshot.stocks.map((stock) => [stock.sym, stock]));

  const comi = bySym.get("COMI")!;
  assert.equal(comi.amount, 12_500_000);
  assert.equal(comi.pe, 18.4);
  assert.equal(comi.divYield, 2.1);
  assert.equal(comi.eps, 0.68);
  assert.equal(comi.high52w, 15.2);
  assert.equal(comi.low52w, 9.9);

  const abuk = bySym.get("ABUK")!;
  assert.equal(abuk.amount, undefined, "absent extended fields are not faked as zero");
  assert.equal(abuk.pe, undefined);
  assert.equal(abuk.divYield, undefined);
  assert.equal(abuk.eps, undefined);
  assert.equal(abuk.high52w, undefined);
  assert.equal(abuk.low52w, undefined);
});

test("duplicate scanner symbols collapse to a single screener row", () => {
  const scan = {
    fetchedAt: NOW,
    stale: false,
    rows: [
      row({ sym: "COMI", close: 12.5, marketCap: 9_000_000_000 }),
      row({ sym: "COMI", close: 12.6, marketCap: 9_000_000_000 }),
      row({ sym: "ETEL", close: 40 }),
    ],
  };

  const snapshot = egxScanToStockSnapshot(scan);
  const comiRows = snapshot.stocks.filter((stock) => stock.sym === "COMI");
  assert.equal(comiRows.length, 1, "no duplicate rows for the same symbol");
  assert.equal(comiRows[0].price, 12.5, "the first (highest-cap) row wins");
  assert.ok(snapshot.stocks.some((stock) => stock.sym === "ETEL"));
});

test("every screener row is an EGX instrument, no foreign market rows", () => {
  const scan = {
    fetchedAt: NOW,
    stale: false,
    rows: [
      row({ sym: "COMI" }),
      row({ sym: "TMGH" }),
      row({ sym: "EGX30", type: "index" }),
    ],
  };

  const snapshot = egxScanToStockSnapshot(scan);
  assert.ok(snapshot.stocks.length > 0);
  for (const stock of snapshot.stocks) {
    assert.ok(
      stock.instrumentId.startsWith("stock:egx:") || stock.instrumentId.startsWith("egx:"),
      `${stock.sym} must be an EGX instrument, got ${stock.instrumentId}`,
    );
  }
  assert.ok(!snapshot.stocks.some((stock) => stock.sym === "EGX30"), "index rows stay out of the equity screener");
});

test("the five reference stocks carry their source fields end-to-end", () => {
  const fixtures: Array<[string, number, number, number, number]> = [
    // sym, close, change_abs, volume, amount (traded value EGP)
    ["COMI", 12.5, -0.2, 1_000_000, 12_500_000],
    ["ETEL", 39.8, 0.4, 800_000, 31_900_000],
    ["TMGH", 152.4, -2.1, 250_000, 38_400_000],
    ["FWRY", 8.75, 0.1, 2_000_000, 17_700_000],
    ["EFIH", 21.3, 0, 300_000, 6_400_000],
  ];

  const scan = {
    fetchedAt: NOW,
    stale: false,
    rows: fixtures.map(([sym, close, changeAbs, volume, amount], index) =>
      row({
        sym,
        description: `EGX:${sym}`,
        close,
        changeAbs,
        change: changeAbs === 0 ? 0 : (changeAbs / (close - changeAbs)) * 100,
        volume,
        amount,
        high: close + 0.5,
        low: close - 0.5,
        open: close,
        marketCap: (10 - index) * 1_000_000_000,
      }),
    ),
  };

  const snapshot = egxScanToStockSnapshot(scan);
  const bySym = new Map(snapshot.stocks.map((stock) => [stock.sym, stock]));

  for (const [sym, close, changeAbs, volume, amount] of fixtures) {
    const stock = bySym.get(sym);
    assert.ok(stock, `${sym} must be in the screener`);
    assert.equal(stock.price, close, `${sym} price`);
    assert.equal(stock.chg, changeAbs, `${sym} absolute change`);
    assert.ok(stock.chgPct !== undefined, `${sym} percent change is published when the source computes it`);
    assert.equal(stock.vol, volume, `${sym} volume`);
    assert.equal(stock.amount, amount, `${sym} traded value`);
    assert.equal(stock.prevClose, close - changeAbs, `${sym} previous close`);
    /* The scanner carries no data timestamp, so the state must be derived
     * from the session itself (live during it, closed with the last close
     * outside it) — never "stale" for an ordinary pause. */
    assert.ok(
      stock.state === "live" || stock.state === "closed",
      `${sym} state must be session-derived (got ${String(stock.state)})`,
    );
  }
  assert.equal(snapshot.pricedCount, 5, "all five priced rows count toward the market");
});

test("the source note states the latency caveat and disappears with an empty scan", () => {
  const priced = egxScanToStockSnapshot({ fetchedAt: NOW, stale: false, rows: [row({ sym: "COMI" })] });
  assert.ok(priced.sourceNote, "a priced EGX snapshot carries the source note");
  assert.match(priced.sourceNote!, /قد تتأخر/, "the note must not present the data as tick-live");
  assert.match(priced.sourceNote!, /TradingView/, "the note names the source");

  const empty = egxScanToStockSnapshot({ fetchedAt: NOW, stale: false, rows: [] });
  assert.equal(empty.sourceNote, undefined, "an unavailable snapshot has no source note");
});

/* ── Service level: the scan honors the quotes' freshness contract ── */

class FakeScannerProvider extends TradingViewScannerProvider {
  calls = 0;
  failNext = 0;

  constructor(
    private scanRows: TvScanRow[],
    private readonly state: ProviderDescriptor["state"] = "configured",
  ) {
    super({});
  }

  setRows(rows: TvScanRow[]): void {
    this.scanRows = rows;
  }

  override descriptor(): ProviderDescriptor {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      note: "synthetic scanner test provider",
      coverage: ["equity"],
      externalDisplayConfirmed: this.state === "configured",
    };
  }

  override async getEgxFullScan(): Promise<TvScanRow[]> {
    this.calls += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("synthetic scanner outage");
    }
    return this.scanRows;
  }
}

function makeService(provider: FakeScannerProvider) {
  return new MarketDataService([provider], [], new MemoryJsonCache());
}

test("getEgxStockScan serves fresh rows and caches them (one fetch per TTL)", async () => {
  const rows = [row({ sym: "COMI", description: "EGX:COMI" })];
  const service = makeService(new FakeScannerProvider(rows));

  const first = await service.getEgxStockScan();
  const second = await service.getEgxStockScan();

  assert.equal(first.rows.length, 1);
  assert.equal(first.stale, false);
  assert.equal(second.rows.length, 1);
  assert.equal(second.stale, false);
  assert.equal(first.fetchedAt, second.fetchedAt, "second call must be a cache hit");
  assert.equal(providerCalls(service), 1, "the scanner is fetched once per TTL");
});

function providerCalls(service: MarketDataService): number {
  const provider = (service as unknown as { providers: FakeScannerProvider[] }).providers[0];
  return provider.calls;
}

test("getEgxStockScan serves the last good scan as stale during an outage", async () => {
  const service = makeService(new FakeScannerProvider([row({ sym: "COMI" })]));
  const fresh = await service.getEgxStockScan();
  assert.equal(fresh.stale, false);

  // The TTL has passed but the stale window is open: seed the cache with an
  // expired entry (staleUntil still in the future) and take the scanner down.
  const cache = (service as unknown as { cache: MemoryJsonCache }).cache;
  const now = Date.now();
  const originalFetch = now - 10 * 60_000;
  await cache.set(
    "egytrend:market:egx-scan:v1",
    { value: fresh.rows, cachedAt: originalFetch, expiresAt: now - 1, staleUntil: now + 60 * 60_000 },
  );
  const provider = (service as unknown as { providers: FakeScannerProvider[] }).providers[0];
  provider.failNext = 1;

  const stale = await service.getEgxStockScan();
  assert.equal(stale.stale, true);
  assert.equal(stale.rows.length, 1);
  // Stale rows report their ORIGINAL fetch time so the UI can show "آخر
  // تحديث منذ 10 دقائق" instead of presenting them as freshly fetched.
  assert.equal(stale.fetchedAt, originalFetch);
});

test("getEgxStockScan fails closed when there is no verified data at all", async () => {
  const service = makeService(new FakeScannerProvider([], "configured"));
  await assert.rejects(() => service.getEgxStockScan(), /no rows|not configured/);
});

test("getEgxStockScan refuses to run when the provider is not configured", async () => {
  const service = makeService(new FakeScannerProvider([], "not_configured"));
  await assert.rejects(() => service.getEgxStockScan(), /not configured/);
});

test("getEgxStockScan refuses an empty scanner response without erasing good data", async () => {
  const service = makeService(new FakeScannerProvider([row({ sym: "COMI" })]));
  const fresh = await service.getEgxStockScan();
  const cache = (service as unknown as { cache: MemoryJsonCache }).cache;
  const now = Date.now();
  await cache.set(
    "egytrend:market:egx-scan:v1",
    { value: fresh.rows, cachedAt: now - 10 * 60_000, expiresAt: now - 1, staleUntil: now + 60 * 60_000 },
  );
  const provider = (service as unknown as { providers: FakeScannerProvider[] }).providers[0];
  provider.setRows([]); // the vendor answers with an empty list

  const result = await service.getEgxStockScan();
  assert.equal(result.stale, true, "an empty response must not replace the last good scan");
  assert.equal(result.rows.length, 1);
});
