-- Per-account onboarding tour/checklist state. Pending local migration only:
-- apply after a verified backup and approved maintenance window.
BEGIN;

CREATE TABLE IF NOT EXISTS user_onboarding (
  user_id integer PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  tour_version integer NOT NULL DEFAULT 1,
  tour_status text NOT NULL DEFAULT 'new',
  tour_started_at timestamp with time zone,
  tour_completed_at timestamp with time zone,
  tour_skipped_at timestamp with time zone,
  watchlist_count integer NOT NULL DEFAULT 0,
  watchlist_completed_at timestamp with time zone,
  notifications_enabled_at timestamp with time zone,
  news_explored_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_onboarding_tour_status_check CHECK (tour_status IN ('new', 'completed', 'skipped')),
  CONSTRAINT user_onboarding_tour_version_check CHECK (tour_version >= 1),
  CONSTRAINT user_onboarding_watchlist_count_check CHECK (watchlist_count BETWEEN 0 AND 3)
);

CREATE INDEX IF NOT EXISTS user_onboarding_tour_status_idx ON user_onboarding(tour_status, updated_at);

COMMIT;
