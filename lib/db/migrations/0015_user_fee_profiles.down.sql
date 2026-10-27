-- Non-destructive rollback: archive user fee schedules (archive-not-delete
-- policy) and leave the tables and the admin-managed catalog row in place.

UPDATE user_fee_profiles
SET status = 'archived'
WHERE status <> 'archived';
