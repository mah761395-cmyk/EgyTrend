---
name: Admin Dashboard Architecture
description: Full production admin dashboard — JWT/RBAC/PostgreSQL schema, 10-tab UI
---

# Admin Dashboard Overhaul

## Backend (artifacts/api-server/src/routes/admin.ts)
- Legacy token auth (SESSION_SECRET static token) preserved for backward compat
- New JWT auth for employee logins via email+password (24h expiry, signed with SESSION_SECRET)
- RBAC via `requireRole(...roles)` middleware: super_admin > admin > editor/analyst/support/marketing
- Passwords hashed with SHA-256 + JWT_SECRET salt
- All mutations write to `audit_logs` table automatically

## Database Schema (lib/db/src/schema/)
- `employees` — staff with roles, email, passwordHash, status, lastLogin
- `subscription_plans` — plan CRUD with key/nameAr/price/durationMonths/features
- `coupons` — discount coupons (percent or fixed), maxUses, startsAt, expiresAt
- `audit_logs` — all admin actions with actor, target, detail, ip, timestamp
- `ai_config` — singleton row: analyzerEnabled, summaryEnabled, rewriterEnabled, dailyRequestLimit
- `ai_usage` — per-request AI usage tracking (userId, requestType, tokensEstimate)

## Frontend (artifacts/egytrend/index.html)
10 admin tabs: dash, users, reqs, articles, sources, plans, coupons, employees, aiconfig, audit
- Users tab: ban/unban/VIP upgrade with localStorage sync + server audit
- Plans tab: full CRUD with features list, badge, active toggle
- Coupons tab: full CRUD with percent/fixed discount, date range, usage stats
- Employees tab: full CRUD with role display, last login, status toggle
- AI Config tab: toggle features, daily limit, AI report generation
- Audit Log tab: paginated list with search/filter by action type

## Key constraints
- Users still in localStorage (no migration needed) — admin actions audit-logged server-side
- `admFetch()` helper sends x-admin-token header; 401 auto-clears token
- Seeds: 3 default plans (monthly/quarterly/yearly) and 2 coupons (WELCOME20/SAVE50) created

**Why:** The previous admin was localStorage-only with static token. Now production-ready with real DB and RBAC.
