# Preview data — production snapshot (DEV-ONLY)

Captured from the **live production API** (`https://egy-trend.vercel.app`) on
**2026-10-30** (Cairo) with anonymous requests — the same endpoints and the
same sources the site uses (Trading Economics, ExchangeRate-API, Yahoo
Finance, CoinGecko, TradingView Scanner, FxPro calendar, admin pricing).

The values, source labels, `asOf`/`refTime` timestamps, and counts below are
the **real** numbers the production server returned at capture time. They are
frozen: this sandbox cannot reach the providers (network allow-list) nor the
production host, so the dev preview (`scripts/preview-landing.mjs`) serves
this snapshot for `/api/*` instead of a live fetch.

| File | Endpoint | Notes |
|---|---|---|
| `markets.json` | `/api/markets` | Full board. Reshaped to the current (post-M1) contract: the four EGP pairs live in the `fx` section; values themselves are the production values. Instruments added after capture (M1: DJI, Nikkei, CAC 40, WTI, natural gas, wheat, USDT/USDC/ADA/DOGE/TRX, intl FX pairs, DXY) are **not** in the snapshot → the client shows them honestly as «غير متاح». |
| `sparklines.json` | `/api/markets/sparklines` | Production state at capture: no stored daily history yet (`available:false`) → no sparklines are drawn, exactly as the product would. |
| `stocks.json` | `/api/markets/stocks` | Real header (`pricedCount:296`, TradingView Scanner, capture ts) + 16 real rows. |
| `us-stocks.json` | `/api/markets/us-stocks` | Production state at capture: unavailable (TV fallback list only). |
| `calendar.json` | `/api/markets/calendar` | Real events (FxPro). |
| `news.json` | `/api/news` | 17 real articles (الأسبوع + أموال الغد) and the real server `count24h:124`. |
| `news-sources.json` | `/api/news/sources` | The 20 approved sources (19 third-party). |
| `payments-config.json` | `/api/payments/config` | Real admin pricing at capture (99/249/799 with old prices). |

Nothing here is a secret. Regenerate by re-fetching the same endpoints from
production and overwriting the files (keep this table accurate).
