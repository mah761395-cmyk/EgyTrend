-- Non-destructive rollback: retain financial scenarios/history, mark them
-- archived, and leave the additive tables in place for a future re-enable.
-- Dropping these tables would violate the archive-not-delete policy.

UPDATE user_calculator_scenarios
SET status = 'archived',
    archived_at = COALESCE(archived_at, now())
WHERE status <> 'archived';

UPDATE user_calculator_activity
SET status = 'archived',
    archived_at = COALESCE(archived_at, now())
WHERE status <> 'archived';
