import assert from "node:assert/strict";
import test from "node:test";
import { MARKET_INSTRUMENTS } from "./catalog";
import { TradingEconomicsEgxIndexProvider } from "./providers";

const egx30 = MARKET_INSTRUMENTS.find((item) => item.id === "egx:EGX30")!;

/**
 * Sample reconstructed from the live tradingeconomics.com/egypt/stock-market
 * page fetched 2026-10-28 (a down day): the summary sentence carries the
 * direction only as the word "losing", and the index table row carries the
 * daily percent with an explicit sign.
 */
const DOWN_DAY_HTML = `<html><body>
<div class="quote-header"><td id="p">49,281.24</td></div>
<p>Egypt's main stock market index, the EGX 30, fell to 49281 points on October 28, 2026, losing 1.64% from the previous session. Over the past month, the index has declined 5.77%, though it remains 28.91% higher than a year ago, according to trading on a contract for difference (CFD) that tracks this benchmark index from Egypt.</p>
<table><tbody><tr><td class="left"><a href="https://tradingeconomics.com/egypt/stock-market">EGX 30</a></td><td>49281</td><td></td><td>824</td><td>-1.64%</td><td>-5.77%</td><td>28.91%</td><td>17:56</td></tr></tbody></table>
</body></html>`;

function quoteFor(html: string, env: NodeJS.ProcessEnv = {}) {
  const provider = new TradingEconomicsEgxIndexProvider(env, {
    async getText(): Promise<string> { return html; },
  } as never);
  return provider.getQuotes([egx30]).then((result) => result.quotes[0]);
}

test("EGX30 down day: the direction word keeps the negative sign", async () => {
  const quote = await quoteFor(DOWN_DAY_HTML);
  assert.equal(quote?.price, 49281.24);
  assert.equal(quote?.changePercent, -1.64);
  assert.equal(quote?.sourceId, "tradingeconomics-egx-index");
});

test("EGX30 up day: 'gaining ... from the previous session' stays positive", async () => {
  const upDayHtml = DOWN_DAY_HTML
    .replace("49,281.24", "50,104.83")
    .replace("fell to 49281 points on October 28, 2026, losing 1.64% from the previous session",
      "rose to 50105 points on October 27, 2026, gaining 1.66% from the previous session");
  const quote = await quoteFor(upDayHtml);
  assert.equal(quote?.price, 50104.83);
  assert.equal(quote?.changePercent, 1.66);
});

test("EGX30 short direction words: 'up' and 'down' map to the right sign", async () => {
  const upHtml = DOWN_DAY_HTML.replace("losing 1.64% from the previous session", "up 0.52% from the previous session");
  assert.equal((await quoteFor(upHtml))?.changePercent, 0.52);
  const downHtml = DOWN_DAY_HTML.replace("losing 1.64% from the previous session", "down 2.10% from the previous session");
  assert.equal((await quoteFor(downHtml))?.changePercent, -2.1);
});

test("EGX30 falls back to the signed table cell when the sentence has no percent", async () => {
  const noSentenceHtml = DOWN_DAY_HTML
    .replace("fell to 49281 points on October 28, 2026, losing 1.64% from the previous session",
      "fell to 49281 points on October 28, 2026.");
  const quote = await quoteFor(noSentenceHtml);
  assert.equal(quote?.changePercent, -1.64);
});

test("EGX30 keeps the previous word-based fallback when no table sign exists", async () => {
  const bareHtml = `<html><body><td id="p">49,281.24</td>
<p>The EGX 30 finished lower, losing 1.64% on the day.</p></body></html>`;
  const quote = await quoteFor(bareHtml);
  assert.equal(quote?.changePercent, -1.64);
});

test("EGX30 quote is omitted when the page has no readable price", async () => {
  const noPriceHtml = `<html><body><p>The EGX 30, losing 1.64% from the previous session.</p></body></html>`;
  const result = await new TradingEconomicsEgxIndexProvider({}, {
    async getText(): Promise<string> { return noPriceHtml; },
  } as never).getQuotes([egx30]);
  assert.deepEqual(result.quotes, []);
});

test("EGX30 provider only serves the index and honours the kill switch", async () => {
  const provider = new TradingEconomicsEgxIndexProvider({});
  assert.equal(provider.canServe(egx30), true);
  const spx = MARKET_INSTRUMENTS.find((item) => item.id === "index:SPX")!;
  assert.equal(provider.canServe(spx), false);
  assert.equal(
    new TradingEconomicsEgxIndexProvider({ LEGACY_MARKET_FEEDS_DISABLED: "true" }).canServe(egx30),
    false,
  );
});
