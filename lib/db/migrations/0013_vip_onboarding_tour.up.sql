-- VIP welcome tour state on the existing onboarding row. Additive only:
-- display/progress state for the guided VIP tour, never an entitlement.
-- Apply after a verified backup and approved maintenance window.

BEGIN;

ALTER TABLE user_onboarding ADD COLUMN IF NOT EXISTS vip_tour_version integer NOT NULL DEFAULT 0;
ALTER TABLE user_onboarding ADD COLUMN IF NOT EXISTS vip_tour_status text NOT NULL DEFAULT 'new';
ALTER TABLE user_onboarding ADD COLUMN IF NOT EXISTS vip_tour_started_at timestamp with time zone;
ALTER TABLE user_onboarding ADD COLUMN IF NOT EXISTS vip_tour_completed_at timestamp with time zone;
ALTER TABLE user_onboarding ADD COLUMN IF NOT EXISTS vip_tour_skipped_at timestamp with time zone;
ALTER TABLE user_onboarding DROP CONSTRAINT IF EXISTS user_onboarding_vip_tour_status_check;
ALTER TABLE user_onboarding ADD CONSTRAINT user_onboarding_vip_tour_status_check CHECK (vip_tour_status IN ('new', 'completed', 'skipped'));

COMMIT;
