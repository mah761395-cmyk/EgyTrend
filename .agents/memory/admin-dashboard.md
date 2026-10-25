---
name: Admin Dashboard Architecture
description: Current security model for the EgyTrend administrative dashboard
---

# Admin Dashboard — Current Architecture

> **Operational note:** This is an internal implementation memory, not a deployment runbook. Never place credentials, fixed admin tokens, payment credentials, or provider keys in this file.

## Authentication and authorization

- Staff sign in through `/api/admin/login` with their own employee e-mail and password.
- Passwords use salted `scrypt` hashes. A legacy hash may be upgraded only after a successful login; new records never use legacy hashing.
- The browser receives a short-lived, signed `HttpOnly`, `SameSite=Lax` admin-session cookie. It is not a JavaScript-readable credential.
- Each protected request resolves the signed employee ID against the current `employees` row. Disabled/archived employees and stale role claims are rejected immediately.
- There is **no** `x-admin-token`, `ADMIN_TOKEN`, static header, or `localStorage` authorization path.
- A password-only `break_glass` session is a temporary bootstrap recovery path, has a short expiry, and stops working as soon as an active staff `super_admin` exists. It must not be treated as a normal account.
- RBAC is server-enforced: `super_admin`, `admin`, `editor`, `analyst`, `support`, and `marketing`. Sensitive pricing permissions are separately checked from the current employee row.

## Data and audit behavior

- `employees`, payment decisions/settings, plans, coupons, subscriptions, AI controls, and audit logs are server/DB authoritative.
- Destructive-looking operations preserve history: employee deletion archives the employee; coupon deletion disables it; plans are made inactive rather than removed.
- The last active `super_admin` cannot be removed through archive, disable, or demotion flows.
- Admin mutations write a minimized audit event; audit data must not become a shadow store for passwords, payment proofs, or full personal data.
- Payment collection is fail-closed. A payment method must have an explicitly enabled DB setting and a valid configured address; no static default wallet is acceptable.

## Frontend contract

- The public client is `artifacts/egytrend/index.html`; the admin client is `artifacts/egytrend/admin.html`.
- UI state may improve usability, but it never grants VIP/admin access or supplies server-trusted user/payment data.
- Admin writes must use the cookie-backed server API, perform CSRF/origin checks provided by the app, and handle `401`/`403` by returning to sign-in rather than trying a local fallback.

## Safe operating constraints

- Do not seed production plans, coupons, employees, payment settings, or mock successes from the frontend or a local script.
- Before a database change: use an approved Preview/Test environment, a verified backup, and paired reversible migrations via `scripts/run-db-migration.mjs`. It intentionally refuses production.
- Use `lib/db/migrations/README.md`, `.env.example`, and the current release preflight for the authoritative operational procedure.
