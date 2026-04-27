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

External services used by the page (no backend in this artifact): rss2json.com proxy for RSS feeds, CoinGecko for crypto prices, Anthropic API direct from browser for AI features.
