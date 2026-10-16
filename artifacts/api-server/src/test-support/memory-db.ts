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
      name text NOT NULL,
      password_hash text NOT NULL,
      plan text NOT NULL DEFAULT 'free',
      vip_expires_at timestamp,
      status text NOT NULL DEFAULT 'active',
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
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
      status text NOT NULL DEFAULT 'active',
      starts_at timestamp NOT NULL,
      expires_at timestamp NOT NULL,
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
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_at timestamp
    );
    CREATE TABLE user_notifications (
      id text PRIMARY KEY,
      phone text NOT NULL,
      kind text NOT NULL DEFAULT 'info',
      title text NOT NULL,
      body text NOT NULL,
      read_at timestamp,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
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
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
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
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
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
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return {
    db: drizzle(pool as never, { schema }) as EgyTrendDatabase,
    close: async () => { await pool.end(); },
  };
}
