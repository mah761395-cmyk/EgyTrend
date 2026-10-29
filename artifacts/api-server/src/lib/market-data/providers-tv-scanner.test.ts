import assert from "node:assert/strict";
import test from "node:test";
import { TradingViewScannerProvider, type TvScanRow } from "./providers";

/**
 * Contract for the Egypt screener scan:
 *  - the core 12-column scan is the load-bearing request,
 *  - "amount" (traded value) and the valuation set are OPTIONAL extended
 *    passes, merged per symbol,
 *  - a rejected extended pass (unsupported column → HTTP 400 upstream) must
 *    leave the core rows intact with the extended fields simply absent —
 *    never a failed screener, never an invented value,
 *  - index rows keep their type so callers can exclude them from the
 *    equity screener.
 */

type ScanPayload = { data: Array<{ s: string; d: unknown[] }> };

function payloadFor(columns: string[], rows: Record<string, unknown>[]): ScanPayload {
  return {
    data: rows.map((row) => ({
      s: String(row.name),
      d: columns.map((column) => (column in row ? row[column] : null)),
    })),
  };
}

/** Fake http that dispatches on the requested column set. */
function fakeHttp(overrides: {
  core?: ScanPayload | Error;
  amount?: ScanPayload | Error;
  valuation?: ScanPayload | Error;
} = {}) {
  const calls: string[][] = [];
  return {
    calls,
    async postJson<T>(_url: string, body: unknown): Promise<T> {
      const columns = ((body as { columns?: string[] }).columns ?? []).join(",");
      calls.push(columns.split(","));
      const key = columns.includes("amount")
        ? "amount"
        : columns.includes("pe_basic")
          ? "valuation"
          : "core";
      const value = (key === "core" ? overrides.core : key === "amount" ? overrides.amount : overrides.valuation) ?? { data: [] };
      if (value instanceof Error) throw value;
      return value as T;
    },
  };
}

const COMI = {
  name: "EGX:COMI", type: "stock", description: "Commodity Co.",
  close: 12.5, change: -1.57, change_abs: -0.2, open: 12.7, high: 12.9, low: 12.3,
  volume: 1_000_000, market_cap_basic: 8_000_000_000, sector: "Basic Materials",
};
const ABUK = {
  name: "EGX:ABUK", type: "stock", description: "Abu Qir",
  close: 40, change: 0.5, change_abs: 0.2, open: 39.9, high: 40.4, low: 39.8,
  volume: 500_000, market_cap_basic: 2_000_000_000, sector: "Basic Materials",
};
const EGX30 = { name: "EGX:EGX30", type: "index", description: "EGX 30", close: 49_000, change: -1.6, change_abs: -800 };

const CORE_COLUMNS = ["type", "name", "description", "close", "change", "change_abs", "open", "high", "low", "volume", "market_cap_basic", "sector"];

test("core scan maps every column 1:1 and strips the market prefix", async () => {
  const http = fakeHttp({ core: payloadFor(CORE_COLUMNS, [COMI, ABUK, EGX30]) });
  const provider = new TradingViewScannerProvider({}, http as never);
  const rows = await provider.getEgxFullScan();

  assert.equal(rows.length, 3);
  const comi = rows.find((row) => row.sym === "COMI")!;
  assert.equal(comi.type, "stock");
  assert.equal(comi.description, "Commodity Co.");
  assert.equal(comi.close, 12.5);
  assert.equal(comi.change, -1.57);
  assert.equal(comi.changeAbs, -0.2);
  assert.equal(comi.open, 12.7);
  assert.equal(comi.high, 12.9);
  assert.equal(comi.low, 12.3);
  assert.equal(comi.volume, 1_000_000);
  assert.equal(comi.marketCap, 8_000_000_000);
  assert.equal(comi.sector, "Basic Materials");
  // Index rows keep their type so the screener can exclude them.
  assert.equal(rows.find((row) => row.sym === "EGX30")?.type, "index");
  // Core-only payload: extended fields are absent, not zero.
  assert.equal(comi.amount, undefined);
  assert.equal(comi.pe, undefined);
  assert.equal(comi.high52w, undefined);
});

test("null scanner cells stay undefined (no invented values)", async () => {
  const sparse: Record<string, unknown> = { ...COMI, volume: null, high: null, market_cap_basic: null };
  const http = fakeHttp({ core: payloadFor(CORE_COLUMNS, [sparse]) });
  const provider = new TradingViewScannerProvider({}, http as never);
  const [row] = await provider.getEgxFullScan();
  assert.equal(row.close, 12.5);
  assert.equal(row.volume, undefined);
  assert.equal(row.high, undefined);
  assert.equal(row.marketCap, undefined);
});

test("the amount pass enriches traded value per symbol", async () => {
  const http = fakeHttp({
    core: payloadFor(CORE_COLUMNS, [COMI]),
    amount: payloadFor(["name", "amount"], [{ name: "EGX:COMI", amount: 12_500_000 }]),
  });
  const provider = new TradingViewScannerProvider({}, http as never);
  const [row] = await provider.getEgxFullScan();
  assert.equal(row.amount, 12_500_000);
});

test("the valuation pass enriches P/E, dividend yield, EPS and 52-week range", async () => {
  const http = fakeHttp({
    core: payloadFor(CORE_COLUMNS, [COMI]),
    valuation: payloadFor(
      ["name", "pe_basic", "dividend_yield_basic", "eps_basic", "price_52_week_high", "price_52_week_low"],
      [{ name: "EGX:COMI", pe_basic: 18.4, dividend_yield_basic: 2.1, eps_basic: 0.68, price_52_week_high: 15.2, price_52_week_low: 9.9 }],
    ),
  });
  const provider = new TradingViewScannerProvider({}, http as never);
  const [row] = await provider.getEgxFullScan();
  assert.equal(row.pe, 18.4);
  assert.equal(row.divYield, 2.1);
  assert.equal(row.eps, 0.68);
  assert.equal(row.high52w, 15.2);
  assert.equal(row.low52w, 9.9);
});

test("a rejected extended pass leaves the core scan intact (fail-soft)", async () => {
  const notSupported = new Error("upstream HTTP 400");
  const http = fakeHttp({
    core: payloadFor(CORE_COLUMNS, [COMI, ABUK]),
    amount: notSupported,
    valuation: notSupported,
  });
  const provider = new TradingViewScannerProvider({}, http as never);
  const rows = await provider.getEgxFullScan();
  assert.equal(rows.length, 2);
  const comi = rows.find((row) => row.sym === "COMI")!;
  assert.equal(comi.close, 12.5);
  assert.equal(comi.amount, undefined);
  assert.equal(comi.pe, undefined);
  assert.equal(comi.low52w, undefined);
});

test("extended rows for unknown symbols are ignored (merge, not insert)", async () => {
  const http = fakeHttp({
    core: payloadFor(CORE_COLUMNS, [COMI]),
    amount: payloadFor(["name", "amount"], [
      { name: "EGX:COMI", amount: 1 },
      { name: "EGX:GHOST", amount: 999 },
    ]),
  });
  const provider = new TradingViewScannerProvider({}, http as never);
  const rows = await provider.getEgxFullScan();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 1);
});

test("disabled provider serves no rows", async () => {
  const http = fakeHttp({});
  const provider = new TradingViewScannerProvider({ LEGACY_MARKET_FEEDS_DISABLED: "true" }, http as never);
  await assert.deepEqual(await provider.getEgxFullScan(), []);
  assert.equal(http.calls.length, 0, "no upstream request when disabled");
});

test("a row without a name is dropped, never published as a blank symbol", async () => {
  const http = fakeHttp({ core: payloadFor(CORE_COLUMNS, [{ ...COMI, name: null }, ABUK]) });
  const provider = new TradingViewScannerProvider({}, http as never);
  const rows = await provider.getEgxFullScan();
  assert.deepEqual(rows.map((row: TvScanRow) => row.sym), ["ABUK"]);
});
