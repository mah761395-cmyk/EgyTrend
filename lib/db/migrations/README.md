# Database migrations

`0001_market_daily_ohlc` through `0011_user_onboarding` are **pending, unexecuted** migrations.

They are intentionally SQL files rather than a `drizzle-kit push`: no verified isolated database connection exists in this workspace, and an agent must never change a shared or production database without an approved backup and deployment window.

- `0001_market_daily_ohlc` adds licensed-market daily snapshot storage.
- `0002_user_subscriptions` introduces the server-side VIP entitlement record. It backfills only existing VIP accounts with a recorded future expiry. Records with a missing legacy expiry are left untouched and use the temporary compatibility path until an operator verifies them; the migration never invents an expiry date.
- `0003_portfolio_positions` stores user-entered positions server-side. It never stores a market quote: all displayed market values remain runtime source/as-of data, and rollback archives the personal records.
- `0004_user_price_alerts` stores server-evaluated price/daily-change rules and their trigger provenance. Evaluation is inert until an approved server-to-server scheduler supplies `CRON_SECRET`; it ignores end-of-day, unknown, or stale quotes and sends email only to the alert owner's recorded address.
- `0005_subscription_plan_pricing` adds server-evaluated base/offer pricing, audience targeting, immutable payment-price snapshots and reversible pricing history. It never rewrites an existing payment request, subscription, or plan price; the rollback archives new offer/history tables and retains financial snapshot columns.
- `0006_user_calculator_scenarios` adds saved VIP calculator scenarios and explicit save/copy/export activity. Input/result JSON is server-validated and size bounded; a scenario is archived rather than deleted. Its rollback marks records archived and leaves the additive tables in place, so no financial scenario is destroyed.
- `0007_subscription_lifecycle` normalizes entitlement instants to UTC, gives each paid term a fresh cycle id, adds an optional per-term grace endpoint, server-authored notification CTAs, durable reminder/outbox state, and immutable lifecycle metric events. The only conversion interprets existing subscription timestamps as the API's documented UTC values; it does not manufacture expiry dates. Its rollback archives the new reminder/event tables and deliberately retains added columns and UTC semantics.
- `0008_admin_broadcasts` adds server-selected public announcements, validated image media, one durable display/interaction row per registered user and announcement, and audit-friendly admin preview records. It also adds explicit account-level marketing opt-in/opt-out timestamps; consent is not inferred from a recovery email and no campaign sender is introduced by this migration. The rollback archives broadcast tables and intentionally keeps consent evidence rather than deleting it.
- `0009_free_vip_trial` adds the configurable free-VIP trial claim/subscription and its durable message state. It does not enable a trial by itself; the feature remains disabled until an authorized admin enables it.
- `0010_referral_program` adds configurable referral snapshots, fraud-review signals, reward ledger rows, and automatic referral-coupon metadata. Its rollback drops referral history, so it must only be used after a verified backup and an explicit operator decision to discard that history.
- `0011_user_onboarding` adds an account-owned tour/checklist record. It contains only product-navigation progress; it never changes a subscription, payment, entitlement, or portfolio/alert record. Its rollback only removes that onboarding state.

## Safe execution sequence

1. Point `DATABASE_URL` at a verified **Preview/Test** database only.
2. Run and verify `node scripts/backup-db.mjs`; retain the backup outside the deployment artifact.
3. Review the appropriate `up` SQL and execute it through the approved migration runner.
4. Run the synthetic lifecycle/history tests and a Preview smoke test.
5. Reconcile any legacy VIP rows with no expiry before promoting entitlement-only authorization.
6. Promote only after explicit approval for the production backup, migration, and deployment window.

Review every paired `down` script before use. Most preserve a rollback archive or mark added records archived; `0010_referral_program.down.sql` is explicitly destructive to referral history and therefore requires a verified backup and an operator decision. Revert application code first; restore only after investigation.
