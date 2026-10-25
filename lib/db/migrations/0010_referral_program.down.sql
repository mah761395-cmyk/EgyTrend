-- Rollback only after a verified backup and maintenance approval. Referral
-- history is intentionally destructive on rollback; production should archive
-- it externally first if a rollback is unavoidable.
BEGIN;
DROP TABLE IF EXISTS referral_click_events;
DROP TABLE IF EXISTS referral_message_deliveries;
DROP TABLE IF EXISTS referral_message_templates;
DROP TABLE IF EXISTS referral_reward_ledger;
DROP TABLE IF EXISTS referral_rewards;
DROP TABLE IF EXISTS referral_review_signals;
DROP TABLE IF EXISTS referral_attributions;
DROP INDEX IF EXISTS referral_codes_active_user_owner_uidx;
DROP TABLE IF EXISTS referral_codes;
DROP TABLE IF EXISTS referral_tiers;
DROP TABLE IF EXISTS referral_campaigns;
DROP TABLE IF EXISTS referral_program_settings;
DROP INDEX IF EXISTS coupons_referral_reward_idx;
DROP INDEX IF EXISTS coupons_owner_auto_apply_idx;
ALTER TABLE coupons
  DROP COLUMN IF EXISTS auto_apply,
  DROP COLUMN IF EXISTS renewal_only,
  DROP COLUMN IF EXISTS first_subscription_only,
  DROP COLUMN IF EXISTS referral_reward_id,
  DROP COLUMN IF EXISTS owner_user_id;
DROP INDEX IF EXISTS payment_requests_proof_hash_idx;
DROP INDEX IF EXISTS payment_requests_referral_reward_idx;
ALTER TABLE payment_requests
  DROP COLUMN IF EXISTS referral_reward_id,
  DROP COLUMN IF EXISTS proof_hash,
  DROP COLUMN IF EXISTS sender_phone;
COMMIT;
