-- Replay timestamp for the VIP welcome tour on the existing onboarding row.
-- Additive only: one nullable column, never an entitlement.
-- Replay sets this column (server-side) without touching the permanent
-- vip_tour_status, so a replayed tour can never re-arm the auto-start.
-- Apply after a verified backup and approved maintenance window.

BEGIN;

ALTER TABLE user_onboarding ADD COLUMN IF NOT EXISTS vip_tour_replayed_at timestamp with time zone;

COMMIT;
