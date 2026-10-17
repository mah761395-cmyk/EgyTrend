-- Rollback only after a verified backup and maintenance approval. This removes
-- onboarding display/progress state only; it never changes account, trial,
-- portfolio, alert, payment, or entitlement records.
BEGIN;
DROP TABLE IF EXISTS user_onboarding;
COMMIT;
