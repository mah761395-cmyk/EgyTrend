-- Removes only the replay timestamp; the permanent tour status is untouched.
BEGIN;
ALTER TABLE user_onboarding DROP COLUMN IF EXISTS vip_tour_replayed_at;
COMMIT;
