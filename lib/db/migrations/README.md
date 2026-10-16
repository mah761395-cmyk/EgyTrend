# Database migrations

`0001_market_daily_ohlc` through `0006_user_calculator_scenarios` are **pending, unexecuted** migrations.

They are intentionally SQL files rather than a `drizzle-kit push`: no verified isolated database connection exists in this workspace, and an agent must never change a shared or production database without an approved backup and deployment window.

- `0001_market_daily_ohlc` adds licensed-market daily snapshot storage.
- `0002_user_subscriptions` introduces the server-side VIP entitlement record. It backfills only existing VIP accounts with a recorded future expiry. Records with a missing legacy expiry are left untouched and use the temporary compatibility path until an operator verifies them; the migration never invents an expiry date.
- `0003_portfolio_positions` stores user-entered positions server-side. It never stores a market quote: all displayed market values remain runtime source/as-of data, and rollback archives the personal records.
- `0004_user_price_alerts` stores server-evaluated price/daily-change rules and their trigger provenance. Evaluation is inert until an approved server-to-server scheduler supplies `CRON_SECRET`; it ignores end-of-day, unknown, or stale quotes and sends email only to the alert owner's recorded address.
- `0005_subscription_plan_pricing` adds server-evaluated base/offer pricing, audience targeting, immutable payment-price snapshots and reversible pricing history. It never rewrites an existing payment request, subscription, or plan price; the rollback archives new offer/history tables and retains financial snapshot columns.
- `0006_user_calculator_scenarios` adds saved VIP calculator scenarios and explicit save/copy/export activity. Input/result JSON is server-validated and size bounded; a scenario is archived rather than deleted. Its rollback marks records archived and leaves the additive tables in place, so no financial scenario is destroyed.

## Safe execution sequence

1. Point `DATABASE_URL` at a verified **Preview/Test** database only.
2. Run and verify `node scripts/backup-db.mjs`; retain the backup outside the deployment artifact.
3. Review the appropriate `up` SQL and execute it through the approved migration runner.
4. Run the synthetic lifecycle/history tests and a Preview smoke test.
5. Reconcile any legacy VIP rows with no expiry before promoting entitlement-only authorization.
6. Promote only after explicit approval for the production backup, migration, and deployment window.

Each paired `down` script is intentionally non-destructive: it either preserves a rollback archive or marks the added records archived rather than dropping financial/user data. Revert application code first; restore only after investigation.
