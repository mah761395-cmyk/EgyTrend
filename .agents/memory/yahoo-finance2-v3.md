---
name: yahoo-finance2 v3 usage
description: How to correctly instantiate and use yahoo-finance2 v3 in an esbuild/ESM project; EGX stock symbol format
---

## The rule
`yahoo-finance2` v3 changed from a module-level singleton to a class. The `default` export is the `YahooFinance` class itself — you MUST call it with `new`.

## How to apply

In CJS/require context inside an ESM esbuild project:
```typescript
const YFClass = require("yahoo-finance2").default as new(opts?: Record<string, unknown>) => { quote: (...) => Promise<...> };
const yf = new YFClass({ suppressNotices: ["yahooSurvey"] });
const q = await yf.quote("CIB.CA", {}, { validateResult: false });
```

**Why:** Calling `yf.quote()` on the raw default export (without `new`) throws "Call `const yahooFinance = new YahooFinance()` first." The `default` export is the class, not an instance.

## EGX stock symbols
Egyptian Exchange stocks on Yahoo Finance use the `.CA` suffix (Cairo Exchange):
- `CIB.CA`, `COMI.CA`, `HRHO.CA`, `ETEL.CA`, etc.
- Returns `regularMarketPrice`, `trailingPE`, `trailingAnnualDividendYield`, `marketCap`, `epsTrailingTwelveMonths`
- Volume shows `0` when EGX market is closed (normal behavior)
- Works reliably from Replit environment; direct Yahoo Finance HTTP fetch is rate-limited

## Cache strategy
- Quotes: 2-minute cache (`STOCKS_TTL_MS`)
- Route: `GET /api/markets/stocks`
