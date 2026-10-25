-- Rollback only after a verified backup and maintenance approval. Removes VIP
-- tour display state only; it never changes account, trial, portfolio, alert,
-- payment, or entitlement records.

BEGIN;
ALTER TABLE user_onboarding DROP CONSTRAINT IF EXISTS user_onboarding_vip_tour_status_check;
ALTER TABLE user_onboarding DROP COLUMN IF EXISTS vip_tour_version;
ALTER TABLE user_onboarding DROP COLUMN IF EXISTS vip_tour_status;
ALTER TABLE user_onboarding DROP COLUMN IF EXISTS vip_tour_started_at;
ALTER TABLE user_onboarding DROP COLUMN IF EXISTS vip_tour_completed_at;
ALTER TABLE user_onboarding DROP COLUMN IF EXISTS vip_tour_skipped_at;
COMMIT;
