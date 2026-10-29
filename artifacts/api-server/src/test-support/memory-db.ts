import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { newDb } from "pg-mem";
import * as schema from "@workspace/db/schema";

type EgyTrendDatabase = NodePgDatabase<typeof schema>;

/**
 * Ephemeral PostgreSQL-compatible database for automated tests only.
 * It has no network listener, no production credentials, and is destroyed
 * at test-process exit. Seed values are deliberately synthetic.
 */
export async function createMemoryDatabase(): Promise<{
  db: EgyTrendDatabase;
  close: () => Promise<void>;
}> {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const pg = memory.adapters.createPg();
  const pool = new pg.Pool();

  // drizzle's node-postgres adapter attaches a custom `types.getTypeParser`
  // object and asks for array rows on prepared queries. pg-mem deliberately
  // does not implement either optional node-postgres hook. Normalize only
  // those adapter hints in the isolated test pool and reconstruct array rows;
  // SQL and values are unchanged, and production uses the real driver.
  const normalizeDrizzleQuery = (query: unknown) => {
    if (!query || typeof query !== "object") return { query, wantsArrayRows: false };
    const { types: _types, rowMode, ...withoutUnsupportedOptions } = query as Record<string, unknown>;
    return { query: withoutUnsupportedOptions, wantsArrayRows: rowMode === "array" };
  };
  const patchQuery = (target: { query: (...args: unknown[]) => unknown }) => {
    const originalQuery = target.query.bind(target);
    target.query = (query: unknown, ...args: unknown[]) => {
      const normalized = normalizeDrizzleQuery(query);
      const adaptResult = (result: unknown) => {
        if (!normalized.wantsArrayRows || !result || typeof result !== "object") return result;
        const pgResult = result as { rows?: unknown[]; fields?: Array<{ name?: string }> };
        if (!Array.isArray(pgResult.rows) || Array.isArray(pgResult.rows[0])) return result;
        // pg-mem leaves `fields` incomplete for some RETURNING statements,
        // whereas its object-row key insertion order follows the SELECT /
        // RETURNING projection. That is the same order Drizzle requested.
        const names = Object.keys((pgResult.rows[0] || {}) as Record<string, unknown>);
        return {
          ...pgResult,
          rows: pgResult.rows.map((row) => names.map((name) => (row as Record<string, unknown>)[name])),
        };
      };
      const result = originalQuery(normalized.query, ...args);
      return result && typeof (result as Promise<unknown>).then === "function"
        ? (result as Promise<unknown>).then(adaptResult)
        : adaptResult(result);
    };
  };
  patchQuery(pool as unknown as { query: (...args: unknown[]) => unknown });
  const originalConnect = pool.connect.bind(pool);
  (pool as unknown as { connect: () => Promise<{ query: (...args: unknown[]) => unknown }> }).connect = async () => {
    const client = await originalConnect();
    patchQuery(client as unknown as { query: (...args: unknown[]) => unknown });
    return client as unknown as { query: (...args: unknown[]) => unknown };
  };

  await pool.query(`
    CREATE TABLE app_users (
      id serial PRIMARY KEY,
      phone text NOT NULL UNIQUE,
      email text UNIQUE,
      email_verified_at timestamp,
      marketing_email_opt_in boolean NOT NULL DEFAULT false,
      marketing_email_opted_in_at timestamp,
      marketing_email_unsubscribed_at timestamp,
      name text NOT NULL,
      password_hash text NOT NULL,
      plan text NOT NULL DEFAULT 'free',
      vip_expires_at timestamp,
      status text NOT NULL DEFAULT 'active',
      last_login_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE user_onboarding (
      user_id integer PRIMARY KEY REFERENCES app_users(id),
      tour_version integer NOT NULL DEFAULT 1,
      tour_status text NOT NULL DEFAULT 'new',
      tour_started_at timestamp,
      tour_completed_at timestamp,
      tour_skipped_at timestamp,
      watchlist_count integer NOT NULL DEFAULT 0,
      watchlist_completed_at timestamp,
      notifications_enabled_at timestamp,
      news_explored_at timestamp,
      vip_tour_version integer NOT NULL DEFAULT 0,
      vip_tour_status text NOT NULL DEFAULT 'new',
      vip_tour_started_at timestamp,
      vip_tour_completed_at timestamp,
      vip_tour_skipped_at timestamp,
      vip_tour_replayed_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX user_onboarding_tour_status_idx ON user_onboarding(tour_status, updated_at);
    CREATE TABLE data_quality_events (
      id serial PRIMARY KEY,
      recorded_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
      source_id text NOT NULL,
      kind text NOT NULL,
      instrument_id text,
      latency_ms integer,
      message text NOT NULL,
      incident_key text
    );
    CREATE INDEX data_quality_events_recent_idx ON data_quality_events (recorded_at DESC);
    CREATE INDEX data_quality_events_source_kind_idx ON data_quality_events (source_id, kind, recorded_at DESC);
    CREATE INDEX data_quality_events_incident_idx ON data_quality_events (incident_key, recorded_at DESC) WHERE incident_key IS NOT NULL;
    CREATE TABLE password_resets (
      id serial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES app_users(id),
      token_hash text NOT NULL,
      expires_at timestamp NOT NULL,
      used_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE employees (
      id serial PRIMARY KEY,
      name text NOT NULL,
      email text NOT NULL UNIQUE,
      role text NOT NULL DEFAULT 'editor',
      status text NOT NULL DEFAULT 'active',
      password_hash text NOT NULL,
      permissions jsonb DEFAULT '[]'::jsonb,
      last_login timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE subscription_plans (
      id serial PRIMARY KEY,
      key text NOT NULL UNIQUE,
      name_ar text NOT NULL,
      price integer NOT NULL,
      old_price integer,
      price_badge_mode text NOT NULL DEFAULT 'none',
      price_badge_text text,
      duration_months integer NOT NULL,
      features jsonb DEFAULT '[]'::jsonb,
      is_active boolean DEFAULT true,
      badge text,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE plan_price_offers (
      id text PRIMARY KEY,
      plan_id integer NOT NULL REFERENCES subscription_plans(id),
      audience text NOT NULL DEFAULT 'all',
      price integer NOT NULL,
      old_price integer,
      badge_mode text NOT NULL DEFAULT 'none',
      badge_text text,
      starts_at timestamp,
      ends_at timestamp,
      show_countdown boolean NOT NULL DEFAULT false,
      priority integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'active',
      archived_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE plan_price_change_logs (
      id text PRIMARY KEY,
      plan_id integer NOT NULL REFERENCES subscription_plans(id),
      changed_by integer,
      changed_by_name text,
      changed_by_role text,
      change_type text NOT NULL DEFAULT 'pricing_update',
      before_state jsonb NOT NULL,
      after_state jsonb NOT NULL,
      reverted_at timestamp,
      reverted_by integer,
      reverted_by_name text,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE user_subscriptions (
      id text PRIMARY KEY,
      user_id integer NOT NULL UNIQUE REFERENCES app_users(id),
      plan_key text NOT NULL,
      plan_name_ar text NOT NULL,
      plan_duration_months integer NOT NULL,
      plan_features jsonb NOT NULL DEFAULT '[]'::jsonb,
      subscription_type text NOT NULL DEFAULT 'paid',
      trial_feature_scope jsonb,
      trial_ai_daily_limit integer,
      trial_started_at timestamp,
      trial_ends_at timestamp,
      trial_ended_at timestamp,
      trial_converted_at timestamp,
      status text NOT NULL DEFAULT 'active',
      cycle_id text NOT NULL UNIQUE,
      starts_at timestamp NOT NULL,
      expires_at timestamp NOT NULL,
      grace_ends_at timestamp,
      payment_request_id text,
      source text NOT NULL DEFAULT 'payment',
      cancelled_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX user_subscriptions_active_expiry_idx ON user_subscriptions(status, expires_at);
    CREATE TABLE portfolio_positions (
      id text PRIMARY KEY,
      user_id integer NOT NULL REFERENCES app_users(id),
      instrument_id text NOT NULL,
      symbol text NOT NULL,
      quantity integer NOT NULL,
      average_cost numeric(18, 6) NOT NULL,
      currency text NOT NULL DEFAULT 'EGP',
      status text NOT NULL DEFAULT 'active',
      archived_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, symbol)
    );
    CREATE INDEX portfolio_positions_user_status_idx ON portfolio_positions(user_id, status);
    CREATE TABLE portfolio_transactions (
      id text PRIMARY KEY,
      user_id integer NOT NULL REFERENCES app_users(id),
      instrument_id text NOT NULL,
      symbol text NOT NULL,
      side text NOT NULL,
      quantity integer NOT NULL,
      price numeric(18, 6) NOT NULL,
      fees numeric(18, 6) NOT NULL DEFAULT 0,
      currency text NOT NULL DEFAULT 'EGP',
      trade_date date NOT NULL,
      note text,
      archived_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (side IN ('buy','sell')),
      CHECK (quantity > 0),
      CHECK (price > 0),
      CHECK (fees >= 0)
    );
    CREATE INDEX portfolio_transactions_user_date_idx ON portfolio_transactions(user_id, trade_date);
    CREATE TABLE portfolio_settings (
      user_id integer PRIMARY KEY REFERENCES app_users(id),
      starting_cash numeric(18, 6) NOT NULL DEFAULT 0,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (starting_cash >= 0)
    );
    CREATE TABLE user_price_alerts (
      id text PRIMARY KEY,
      user_id integer NOT NULL REFERENCES app_users(id),
      instrument_id text NOT NULL,
      symbol text NOT NULL,
      condition text NOT NULL,
      target_value numeric(18, 6) NOT NULL,
      email_enabled boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'active',
      last_evaluated_at timestamp,
      triggered_at timestamp,
      trigger_value numeric(18, 6),
      trigger_source text,
      trigger_as_of timestamp,
      email_status text NOT NULL DEFAULT 'not_requested',
      email_sent_at timestamp,
      archived_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, symbol, condition, target_value)
    );
    CREATE INDEX user_price_alerts_status_idx ON user_price_alerts(status, updated_at);
    CREATE INDEX user_price_alerts_user_status_idx ON user_price_alerts(user_id, status);
    CREATE TABLE user_calculator_scenarios (
      id text PRIMARY KEY,
      user_id integer NOT NULL REFERENCES app_users(id),
      calculator_key text NOT NULL,
      name text NOT NULL,
      inputs jsonb NOT NULL,
      result jsonb NOT NULL,
      status text NOT NULL DEFAULT 'active',
      archived_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX user_calculator_scenarios_user_updated_idx ON user_calculator_scenarios(user_id, updated_at);
    CREATE INDEX user_calculator_scenarios_user_status_idx ON user_calculator_scenarios(user_id, status);
    CREATE TABLE user_fee_profiles (
      id text PRIMARY KEY,
      user_id integer NOT NULL REFERENCES app_users(id),
      name text NOT NULL,
      items jsonb NOT NULL,
      status text NOT NULL DEFAULT 'active',
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX user_fee_profiles_user_name_uidx ON user_fee_profiles(user_id, name);
    CREATE INDEX user_fee_profiles_user_status_idx ON user_fee_profiles(user_id, status);
    CREATE TABLE user_calculator_activity (
      id text PRIMARY KEY,
      user_id integer NOT NULL REFERENCES app_users(id),
      calculator_key text NOT NULL,
      action text NOT NULL,
      inputs jsonb NOT NULL,
      result jsonb NOT NULL,
      status text NOT NULL DEFAULT 'active',
      archived_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX user_calculator_activity_user_created_idx ON user_calculator_activity(user_id, created_at);
    CREATE TABLE payment_requests (
      id text PRIMARY KEY,
      phone text NOT NULL,
      name text NOT NULL,
      plan_key text NOT NULL,
      pay_method text NOT NULL DEFAULT '',
      price integer NOT NULL DEFAULT 0,
      price_snapshot jsonb,
      price_locked_until timestamp,
      tx text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      notes text,
      proof_image text,
      proof_name text,
      sender_phone text,
      proof_hash text,
      referral_reward_id text,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_at timestamp
    );
    /* Mirrors production migration 0012 for same-reference concurrency
       regressions. pg-mem supports the exact case-insensitive expression used
       by the real PostgreSQL index. */
    CREATE UNIQUE INDEX payment_requests_tx_normalized_uidx
      ON payment_requests (lower(tx))
      WHERE tx <> '';
    CREATE TABLE user_notifications (
      id text PRIMARY KEY,
      phone text NOT NULL,
      kind text NOT NULL DEFAULT 'info',
      title text NOT NULL,
      body text NOT NULL,
      action_url text,
      action_label text,
      read_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE reminders_sent (
      id text PRIMARY KEY,
      subscription_id text NOT NULL REFERENCES user_subscriptions(id),
      subscription_cycle_id text NOT NULL,
      user_id integer NOT NULL REFERENCES app_users(id),
      reminder_type text NOT NULL,
      reminder_class text NOT NULL DEFAULT 'transactional',
      trial_message_step_id text,
      target_ends_at timestamp NOT NULL,
      delivery_status text NOT NULL DEFAULT 'queued',
      content jsonb NOT NULL,
      in_app_notification_id text,
      in_app_sent_at timestamp,
      email_status text NOT NULL DEFAULT 'pending',
      email_attempts integer NOT NULL DEFAULT 0,
      email_next_attempt_at timestamp,
      email_claim_token text,
      email_claimed_at timestamp,
      email_sent_at timestamp,
      email_last_error text,
      opened_at timestamp,
      clicked_at timestamp,
      cancelled_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(subscription_cycle_id, reminder_type)
    );
    CREATE INDEX subscription_reminders_sent_delivery_idx ON reminders_sent(delivery_status, target_ends_at);
    CREATE INDEX subscription_reminders_sent_email_idx ON reminders_sent(email_status, email_next_attempt_at);
    CREATE TABLE subscription_lifecycle_events (
      id text PRIMARY KEY,
      user_id integer NOT NULL REFERENCES app_users(id),
      subscription_id text NOT NULL REFERENCES user_subscriptions(id),
      subscription_cycle_id text NOT NULL,
      event_type text NOT NULL,
      related_cycle_id text,
      plan_key text NOT NULL,
      occurred_at timestamp NOT NULL,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(subscription_cycle_id, event_type)
    );
    CREATE INDEX subscription_lifecycle_events_type_at_idx ON subscription_lifecycle_events(event_type, occurred_at);
    CREATE TABLE email_verification_tokens (
      id text PRIMARY KEY,
      user_id integer NOT NULL REFERENCES app_users(id),
      token_hash text NOT NULL,
      expires_at timestamp NOT NULL,
      used_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX email_verification_tokens_hash_idx ON email_verification_tokens(token_hash);
    CREATE TABLE trial_claims (
      id text PRIMARY KEY,
      user_id integer NOT NULL UNIQUE REFERENCES app_users(id),
      canonical_email text NOT NULL UNIQUE,
      trial_subscription_id text NOT NULL REFERENCES user_subscriptions(id),
      started_at timestamp NOT NULL,
      converted_at timestamp,
      paid_starts_at timestamp,
      ip_signal_hash text,
      device_signal_hash text,
      manual_override boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE free_trial_message_steps (
      id text PRIMARY KEY,
      timing text NOT NULL,
      offset_days integer NOT NULL DEFAULT 0,
      channels jsonb NOT NULL DEFAULT '[]'::jsonb,
      title_template text NOT NULL,
      body_template text NOT NULL,
      message_type text NOT NULL DEFAULT 'important',
      action_label text,
      action_plan_key text,
      coupon_code text,
      email_marketing boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      created_by integer REFERENCES employees(id),
      updated_by integer REFERENCES employees(id),
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at timestamp
    );
    CREATE INDEX free_trial_message_steps_status_idx ON free_trial_message_steps(status, timing, offset_days);
    CREATE TABLE broadcast_media (
      id text PRIMARY KEY,
      mime_type text NOT NULL,
      data_url text NOT NULL,
      size_bytes integer NOT NULL,
      created_by integer NOT NULL REFERENCES employees(id),
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at timestamp
    );
    CREATE TABLE broadcast_messages (
      id text PRIMARY KEY,
      title text NOT NULL,
      content jsonb NOT NULL,
      message_type text NOT NULL,
      audience text NOT NULL DEFAULT 'all',
      priority integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'draft',
      starts_at timestamp,
      ends_at timestamp,
      image_media_id text REFERENCES broadcast_media(id),
      action jsonb NOT NULL DEFAULT '{"kind":"none"}'::jsonb,
      variable_plan_key text,
      marketing_email_requested boolean NOT NULL DEFAULT false,
      marketing_email_confirmed_at timestamp,
      created_by integer NOT NULL REFERENCES employees(id),
      updated_by integer REFERENCES employees(id),
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at timestamp
    );
    CREATE INDEX broadcast_messages_schedule_idx ON broadcast_messages(status, starts_at, ends_at);
    CREATE TABLE broadcast_message_user_states (
      id text PRIMARY KEY,
      message_id text NOT NULL REFERENCES broadcast_messages(id),
      user_id integer NOT NULL REFERENCES app_users(id),
      seen_at timestamp NOT NULL,
      closed_at timestamp,
      do_not_show_again_at timestamp,
      cta_clicked_at timestamp,
      coupon_copied_at timestamp,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id, user_id)
    );
    CREATE INDEX broadcast_message_user_states_message_idx ON broadcast_message_user_states(message_id, seen_at);
    CREATE TABLE broadcast_test_deliveries (
      id text PRIMARY KEY,
      message_id text NOT NULL REFERENCES broadcast_messages(id),
      employee_id integer NOT NULL REFERENCES employees(id),
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX broadcast_test_deliveries_message_idx ON broadcast_test_deliveries(message_id, created_at);
    CREATE TABLE app_settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ai_config (
      id serial PRIMARY KEY,
      analyzer_enabled boolean DEFAULT true,
      summary_enabled boolean DEFAULT true,
      rewriter_enabled boolean DEFAULT true,
      daily_request_limit integer DEFAULT 1000,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by text
    );
    CREATE TABLE ai_usage (
      id serial PRIMARY KEY,
      user_id text,
      request_type text NOT NULL,
      tokens_estimate integer DEFAULT 0,
      provider text,
      model text,
      tokens_in integer,
      tokens_out integer,
      status text NOT NULL DEFAULT 'reserved',
      cost_est_usd double precision,
      cost_source text,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE db_backups (
      id serial PRIMARY KEY,
      schema_name text NOT NULL,
      table_count integer NOT NULL DEFAULT 0,
      kind text NOT NULL DEFAULT 'manual',
      created_by text,
      verified boolean NOT NULL DEFAULT false,
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE audit_logs (
      id serial PRIMARY KEY,
      action text NOT NULL,
      actor_id integer,
      actor_name text,
      actor_role text,
      target text,
      detail jsonb DEFAULT '{}'::jsonb,
      ip text,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE coupons (
      id serial PRIMARY KEY,
      code text NOT NULL UNIQUE,
      discount_type text NOT NULL DEFAULT 'percent',
      discount_value integer NOT NULL,
      max_uses integer,
      used_count integer DEFAULT 0,
      is_active boolean DEFAULT true,
      starts_at timestamp,
      expires_at timestamp,
      created_by integer,
      owner_user_id integer,
      referral_reward_id text,
      first_subscription_only boolean NOT NULL DEFAULT false,
      renewal_only boolean NOT NULL DEFAULT false,
      auto_apply boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX coupons_referral_reward_idx ON coupons(referral_reward_id);
    CREATE INDEX coupons_owner_auto_apply_idx ON coupons(owner_user_id, auto_apply, is_active);
    CREATE TABLE referral_program_settings (
      id text PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT false,
      attribution_cookie_days integer NOT NULL DEFAULT 30,
      terms_text text NOT NULL DEFAULT '',
      updated_by integer REFERENCES employees(id),
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE referral_campaigns (
      id text PRIMARY KEY,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'paused',
      priority integer NOT NULL DEFAULT 0,
      starts_at timestamp,
      ends_at timestamp,
      qualification_event text NOT NULL DEFAULT 'first_paid',
      hold_days integer NOT NULL DEFAULT 7,
      referrer_reward_type text NOT NULL,
      referrer_reward_value integer NOT NULL,
      referrer_reward_cost integer,
      invitee_reward_type text NOT NULL DEFAULT 'first_subscription_percent',
      invitee_reward_value integer NOT NULL DEFAULT 0,
      invitee_reward_cost integer,
      max_referrer_monthly integer,
      max_referrer_total integer,
      created_by integer REFERENCES employees(id),
      updated_by integer REFERENCES employees(id),
      archived_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX referral_campaigns_schedule_idx ON referral_campaigns(status, starts_at, ends_at, priority);
    CREATE TABLE referral_tiers (
      id text PRIMARY KEY,
      campaign_id text NOT NULL REFERENCES referral_campaigns(id),
      threshold integer NOT NULL,
      reward_type text NOT NULL,
      reward_value integer NOT NULL,
      reward_cost integer,
      status text NOT NULL DEFAULT 'active',
      created_by integer REFERENCES employees(id),
      updated_by integer REFERENCES employees(id),
      archived_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(campaign_id, threshold)
    );
    CREATE INDEX referral_tiers_campaign_status_idx ON referral_tiers(campaign_id, status);
    CREATE TABLE referral_codes (
      id text PRIMARY KEY,
      code text NOT NULL UNIQUE,
      kind text NOT NULL DEFAULT 'user',
      owner_user_id integer REFERENCES app_users(id),
      campaign_id text REFERENCES referral_campaigns(id),
      rule_override jsonb,
      label text,
      status text NOT NULL DEFAULT 'active',
      expires_at timestamp,
      commission_due integer NOT NULL DEFAULT 0,
      commission_notes text,
      created_by integer REFERENCES employees(id),
      updated_by integer REFERENCES employees(id),
      disabled_at timestamp,
      archived_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX referral_codes_campaign_status_idx ON referral_codes(campaign_id, status, expires_at);
    CREATE INDEX referral_codes_owner_user_idx ON referral_codes(owner_user_id);
    CREATE UNIQUE INDEX referral_codes_active_user_owner_uidx ON referral_codes(owner_user_id) WHERE kind = 'user' AND status = 'active' AND archived_at IS NULL;
    CREATE TABLE referral_attributions (
      id text PRIMARY KEY,
      invited_user_id integer NOT NULL UNIQUE REFERENCES app_users(id),
      referrer_user_id integer REFERENCES app_users(id),
      code_id text NOT NULL REFERENCES referral_codes(id),
      campaign_id text NOT NULL REFERENCES referral_campaigns(id),
      code_snapshot text NOT NULL,
      rule_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'registered',
      review_status text NOT NULL DEFAULT 'not_required',
      email_verified_at timestamp,
      trial_started_at timestamp,
      first_paid_at timestamp,
      payment_request_id text,
      ip_signal_hash text,
      device_signal_hash text,
      suspicious boolean NOT NULL DEFAULT false,
      blocked_reason text,
      review_reason text,
      reviewed_by integer REFERENCES employees(id),
      reviewed_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX referral_attributions_referrer_idx ON referral_attributions(referrer_user_id, created_at);
    CREATE INDEX referral_attributions_review_idx ON referral_attributions(review_status, created_at);
    CREATE INDEX referral_attributions_code_idx ON referral_attributions(code_id, created_at);
    CREATE TABLE referral_review_signals (
      id text PRIMARY KEY,
      attribution_id text NOT NULL REFERENCES referral_attributions(id),
      signal_type text NOT NULL,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(attribution_id, signal_type)
    );
    CREATE INDEX referral_review_signals_type_idx ON referral_review_signals(signal_type, created_at);
    CREATE TABLE referral_rewards (
      id text PRIMARY KEY,
      attribution_id text REFERENCES referral_attributions(id),
      campaign_id text NOT NULL REFERENCES referral_campaigns(id),
      tier_id text REFERENCES referral_tiers(id),
      recipient_user_id integer NOT NULL REFERENCES app_users(id),
      recipient_role text NOT NULL,
      reward_type text NOT NULL,
      reward_value integer NOT NULL,
      estimated_cost integer,
      status text NOT NULL DEFAULT 'pending',
      qualification_event text NOT NULL,
      hold_until timestamp,
      payment_request_id text,
      coupon_id integer REFERENCES coupons(id),
      idempotency_key text NOT NULL UNIQUE,
      rule_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      grant_snapshot jsonb,
      reason text,
      granted_by integer REFERENCES employees(id),
      granted_at timestamp,
      cancelled_by integer REFERENCES employees(id),
      cancelled_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX referral_rewards_status_hold_idx ON referral_rewards(status, hold_until);
    CREATE INDEX referral_rewards_recipient_idx ON referral_rewards(recipient_user_id, created_at);
    CREATE INDEX referral_rewards_attribution_idx ON referral_rewards(attribution_id, created_at);
    CREATE TABLE referral_reward_ledger (
      id text PRIMARY KEY,
      reward_id text NOT NULL REFERENCES referral_rewards(id),
      action text NOT NULL,
      reason text,
      actor_employee_id integer REFERENCES employees(id),
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX referral_reward_ledger_reward_idx ON referral_reward_ledger(reward_id, created_at);
    CREATE TABLE referral_message_templates (
      id text PRIMARY KEY,
      event_key text NOT NULL UNIQUE,
      channels jsonb NOT NULL DEFAULT '["in_app"]'::jsonb,
      title_template text NOT NULL,
      body_template text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      updated_by integer REFERENCES employees(id),
      archived_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE referral_message_deliveries (
      id text PRIMARY KEY,
      delivery_key text NOT NULL UNIQUE,
      recipient_user_id integer NOT NULL REFERENCES app_users(id),
      template_id text REFERENCES referral_message_templates(id),
      event_key text NOT NULL,
      notification_id text,
      email_status text NOT NULL DEFAULT 'not_requested',
      content_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX referral_message_deliveries_recipient_idx ON referral_message_deliveries(recipient_user_id, created_at);
    CREATE TABLE referral_click_events (
      id text PRIMARY KEY,
      code_id text NOT NULL REFERENCES referral_codes(id),
      campaign_id text REFERENCES referral_campaigns(id),
      visitor_signal_hash text,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX referral_click_events_campaign_idx ON referral_click_events(campaign_id, created_at);
    CREATE INDEX referral_click_events_code_idx ON referral_click_events(code_id, created_at);
    CREATE TABLE opportunities (
      id varchar(50) PRIMARY KEY,
      title text NOT NULL,
      summary text NOT NULL,
      details text,
      type varchar(50) NOT NULL,
      market varchar(50) NOT NULL,
      expected_return varchar(100),
      risk_level integer NOT NULL DEFAULT 3,
      sector varchar(100),
      duration varchar(100),
      deadline varchar(100),
      status varchar(30) NOT NULL DEFAULT 'active',
      featured boolean NOT NULL DEFAULT false,
      vip_only boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      instrument_id text,
      signal jsonb,
      first_price double precision,
      result text,
      realized_at timestamp
    );
  `);

  /* TASK M: verified daily OHLC store (migration 0001). Some tests insert
   * synthetic bars and exercise the read repository end to end. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_daily_ohlc (
      id text PRIMARY KEY,
      instrument_id text NOT NULL,
      source_id text NOT NULL,
      source_name text NOT NULL,
      trading_date date NOT NULL,
      open double precision NOT NULL,
      high double precision NOT NULL,
      low double precision NOT NULL,
      close double precision NOT NULL,
      volume double precision,
      currency text,
      delayed_minutes integer,
      as_of timestamp with time zone NOT NULL,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT market_daily_ohlc_source_instrument_day_uq UNIQUE (source_id, instrument_id, trading_date)
    );
  `);

  return {
    db: drizzle(pool as never, { schema }) as EgyTrendDatabase,
    close: async () => { await pool.end(); },
  };
}
