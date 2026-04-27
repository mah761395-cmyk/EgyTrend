# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### EgyTrend (`artifacts/egytrend`)

Self-contained Arabic mobile-first financial news / markets / VIP / AI advisor platform served as a single static `index.html` (vanilla HTML/CSS/JS, RTL, Cairo font). All original logic and design from the user-supplied source preserved unchanged.

Responsive desktop/laptop layout was added via `@media (min-width: 1024px)` and `@media (min-width: 1400px)` overrides at the bottom of the inline `<style>` block:
- Container expands from 430px to 1400px max-width with right side-rail navigation (240px).
- Bottom mobile nav is repositioned as a fixed right sidebar (RTL "start" side) with vertical icon+label items.
- News feed becomes a 2-column grid (3 columns on ≥1400px); hero card spans full width.
- Markets grid widens to 4 columns; modals enlarge; detail/EGX pages constrained to ≤980px and respect the sidebar.
- Mobile layout (≤1023px) and tablet (768–1023px) are untouched / lightly tuned.

External services used by the page: Anthropic API direct from browser for AI features. All market data, currency prices, the economic calendar, and RSS news feeds are now fetched through our own backend proxy at `/api/...` (see below). The previous `api.rss2json.com` (news), direct CoinGecko (crypto-only) and hardcoded static market values were retired in favor of the unified backend.

#### News fetching pipeline

- Backend: `artifacts/api-server/src/routes/news.ts` exposes `GET /api/news?source=<id>` and `GET /api/news/sources`. It fetches RSS/Atom feeds server-side with a browser-like User-Agent, parses them with `fast-xml-parser` (handles CDATA, namespaced tags, atom `<link href>`, `media:thumbnail`, `media:content`, `enclosure`), decodes single- and double-encoded HTML entities, strips HTML, normalizes pubDate to ISO, and returns an `rss2json`-compatible `{status:"ok",items:[...]}` shape so the original frontend rendering code keeps working unchanged. Responses are cached in-memory for 5 minutes per source.
- Frontend (`artifacts/egytrend/index.html`): the `SOURCES` array (~line 820) lists 18 sources by `id` only; `fetchSource()` (~line 1107) calls `${NEWS_API}?source=${id}` with a 12s timeout. No URLs are baked into the HTML — all upstream feed URLs live on the server.
- Source list (18): `youm7`, `masrawy`, `amwal`, `elwatan`, `shorouk`, `egnews`, `alarabiya`, `aljazeera`, `bbcar`, `alain`, `reuters`, `cnbc`, `yahoo`, `marketwatch`, `investing`, `ft`, `coindesk`, `cointelegraph`. Several Arabic publishers that block direct RSS or return malformed XML (`elwatan`, `shorouk`, `masrawy`, `alarabiya`, `alain`, plus the new aggregator `egnews`) are sourced through Google News RSS site-search queries, which yields ~100 fresh items per refresh.

#### Markets / currencies / economic calendar pipeline

- Backend: `artifacts/api-server/src/routes/markets.ts` exposes:
  - `GET /api/markets` — returns `{status, ts, markets:{eg,gl,cm,cr}, ticker}`. Each section is an array of `{n, v, c, up, s, clickable?}`. Cached 60s, with stale-on-failure fallback. Sources: **TradingEconomics** (EGX30 scrape), **Google Finance** HTML scrape (`data-last-price` + `P6K39c` previous-close regex) for FX pairs and global indices, **Stooq CSV** as fallback for indices/forex/commodities (gold xauusd, silver xagusd, brent bz.f→cl.f, copper hg.f→hgusd), and **CoinGecko** for crypto (BTC/ETH/BNB/XRP). All upstream calls are parallelized with `Promise.all`.
  - `GET /api/markets/calendar` — returns `{status, events:[{ev, evEn, t, tISO, imp, c, country, countryAr, flag, forecast, previous}]}`. Cached 30 min. Source: **ForexFactory** `ff_calendar_thisweek.json`. The route translates 50+ common event titles to Arabic, formats time in Cairo timezone, attaches country flag emoji + Arabic country name, and emits a high/medium importance label with color.
- Frontend (`artifacts/egytrend/index.html`):
  - `MARKETS_API`/`CALENDAR_API` constants (~line 820) point at the proxy endpoints.
  - `fetchMarketsData()` (~line 1037) replaces the old `fetchCryptoData()`. On success it overwrites `liveMarkets[eg|gl|cm|cr]` (only sections with non-empty arrays) and `liveTicks`, then calls `buildTicker(); buildMarkets(); buildMarketStrip();`. Auto-refreshes every 60s.
  - `fetchCalendarData()` populates `liveCalendar` and calls `buildCalendar()`. Auto-refreshes every 30 min.
  - `buildCalendar()` renders each event with flag, Arabic title, Cairo time, country name, forecast/previous values, and importance pill colored from the backend.
  - First fetch fires on `DOMContentLoaded` so even pre-login users see real numbers; second fetch re-fires on `bootApp()` so refresh intervals start once the user is in.
