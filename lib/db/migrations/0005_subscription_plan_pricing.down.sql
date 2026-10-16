-- Non-destructive rollback for 0005_subscription_plan_pricing.up.sql.
-- Never delete pricing history or payment snapshots during a rollback.
-- New offer/history tables are archived; additive columns stay inert on their
-- original tables so an approved restore does not lose a payment snapshot.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.plan_price_offers') IS NOT NULL
     AND to_regclass('public.plan_price_offers_rollback_archive') IS NULL THEN
    ALTER TABLE plan_price_offers RENAME TO plan_price_offers_rollback_archive;
    ALTER INDEX IF EXISTS plan_price_offers_plan_status_idx
      RENAME TO plan_price_offers_rollback_archive_plan_status_idx;
    ALTER INDEX IF EXISTS plan_price_offers_audience_idx
      RENAME TO plan_price_offers_rollback_archive_audience_idx;
  END IF;

  IF to_regclass('public.plan_price_change_logs') IS NOT NULL
     AND to_regclass('public.plan_price_change_logs_rollback_archive') IS NULL THEN
    ALTER TABLE plan_price_change_logs RENAME TO plan_price_change_logs_rollback_archive;
    ALTER INDEX IF EXISTS plan_price_change_logs_plan_created_idx
      RENAME TO plan_price_change_logs_rollback_archive_plan_created_idx;
  END IF;
END $$;

-- Keep subscription_plans.old_price/price_badge_* and payment_requests
-- price_snapshot/price_locked_until values. They are historical accounting
-- context, so this rollback intentionally does not drop them.

COMMIT;
