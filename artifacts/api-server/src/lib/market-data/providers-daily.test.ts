import assert from "node:assert/strict";
import test from "node:test";
import { MARKET_INSTRUMENTS } from "./catalog";
import { TwelveDataProvider } from "./providers";

const instrument = MARKET_INSTRUMENTS.find((item) => item.id === "index:SPX")!;

test("daily OHLC keeps the vendor candle timestamp and rejects a bar without one", async () => {
  const fakeHttp = {
    async getJson<T>(): Promise<T> {
      return {
        values: [
          { datetime: "2026-10-15", open: "100", high: "102", low: "99", close: "101", volume: "42" },
          { open: "100", high: "102", low: "99", close: "101" },
        ],
      } as T;
    },
  };
  const provider = new TwelveDataProvider({
    TWELVE_DATA_API_KEY: "synthetic-key",
    TWELVE_DATA_EXTERNAL_DISPLAY_LICENSED: "true",
    TWELVE_DATA_LICENSE_REFERENCE: "test-contract-reference",
    TWELVE_DATA_DELAY_MINUTES: "1440",
    TWELVE_DATA_SYMBOLS_JSON: JSON.stringify({ "index:SPX": "SPX_VENDOR" }),
  }, fakeHttp as never);

  const bars = await provider.getDailyOhlc([instrument], "2026-10-15");
  assert.equal(bars.length, 1);
  assert.equal(bars[0]?.tradingDate, "2026-10-15");
  assert.equal(bars[0]?.asOf, Date.parse("2026-10-15T00:00:00.000Z"));
  assert.equal(bars[0]?.freshness, "end-of-day");

  const missingTimeProvider = new TwelveDataProvider({
    TWELVE_DATA_API_KEY: "synthetic-key",
    TWELVE_DATA_EXTERNAL_DISPLAY_LICENSED: "true",
    TWELVE_DATA_LICENSE_REFERENCE: "test-contract-reference",
    TWELVE_DATA_DELAY_MINUTES: "1440",
    TWELVE_DATA_SYMBOLS_JSON: JSON.stringify({ "index:SPX": "SPX_VENDOR" }),
  }, { async getJson<T>(): Promise<T> {
    return { values: [{ open: "100", high: "102", low: "99", close: "101" }] } as T;
  } } as never);
  assert.deepEqual(await missingTimeProvider.getDailyOhlc([instrument], "2026-10-15"), []);
});
