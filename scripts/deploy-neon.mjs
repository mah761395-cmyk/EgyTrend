/* EgyTrend — إعداد قاعدة البيانات السحابية (Neon) من جهازك.
 *
 * يستخدم من Git Bash هكذا (bun يقرأ .env تلقائيًا):
 *   bun scripts/deploy-neon.mjs postgres://...neon.tech/egytrend?sslmode=require
 *   bun scripts/deploy-neon.mjs <NEON_URL> --copy-data   ← ينقل بياناتك المحلية أيضًا
 *
 * ماذا يفعل؟
 *   1) ينشئ كل الجداول على القاعدة السحابية (نفس سكيمة local-schema.sql
 *      + كل المهاجرات: email/reset، إثبات الدفع، الوسائل المتعددة، الإشعارات).
 *      كل الأوامر IF NOT EXISTS — آمن للتكرار.
 *   2) مع --copy-data: ينسخ صفوف جداولك المحلية (المستخدمون، الخطط،
 *      الكوبونات، الفرص، الإعدادات…) إلى السحابة. الجداول الملفية
 *      (مصادر/مقالات الأخبار) مضمّنة في الحزمة ولا تحتاج نسخًا.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire(path.resolve(import.meta.dir, "../lib/db/package.json"));
const { Client } = req("pg");

/* ── تحديد الرابط الهدف ──────────────────────────────────────────────────── */
const argUrl = process.argv.find((a) => a.startsWith("postgres"));
const copyData = process.argv.includes("--copy-data");
if (!argUrl) {
  console.error("استخدام: bun scripts/deploy-neon.mjs <NEON_CONNECTION_URL> [--copy-data]");
  console.error("مثال:  bun scripts/deploy-neon.mjs \"postgres://neondb_owner:...@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require\" --copy-data");
  console.error("(الرابط تاخده من لوحة neon.tech — Connection String → Copy)");
  process.exit(1);
}
let DATABASE_URL = argUrl;
const isNeon = /neon\.tech|neon\.build/.test(DATABASE_URL);
const target = new Client({ connectionString: DATABASE_URL, ssl: isNeon ? { rejectUnauthorized: false } : undefined });
const local = new Client({ connectionString: "postgres://postgres@localhost:5432/egytrend" });

/* ── 1) السكيمة الكاملة (idempotent) ─────────────────────────────────────── */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_users (
  id serial PRIMARY KEY, phone text NOT NULL UNIQUE, name text NOT NULL,
  password_hash text NOT NULL, plan text NOT NULL DEFAULT 'free',
  vip_expires_at timestamp, status text NOT NULL DEFAULT 'active',
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS employees (
  id serial PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'editor', status text NOT NULL DEFAULT 'active',
  password_hash text NOT NULL, permissions jsonb DEFAULT '[]', last_login timestamp,
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS subscription_plans (
  id serial PRIMARY KEY, key text NOT NULL UNIQUE, name_ar text NOT NULL, price integer NOT NULL,
  duration_months integer NOT NULL, features jsonb DEFAULT '[]', is_active boolean DEFAULT true,
  badge text, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS coupons (
  id serial PRIMARY KEY, code text NOT NULL UNIQUE, discount_type text NOT NULL DEFAULT 'percent',
  discount_value integer NOT NULL, max_uses integer, used_count integer DEFAULT 0,
  is_active boolean DEFAULT true, starts_at timestamp, expires_at timestamp,
  created_by integer, created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id serial PRIMARY KEY, action text NOT NULL, actor_id integer, actor_name text, actor_role text,
  target text, detail jsonb DEFAULT '{}', ip text, created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_config (
  id serial PRIMARY KEY, analyzer_enabled boolean DEFAULT true, summary_enabled boolean DEFAULT true,
  rewriter_enabled boolean DEFAULT true, daily_request_limit integer DEFAULT 1000,
  updated_at timestamp NOT NULL DEFAULT now(), updated_by text
);
CREATE TABLE IF NOT EXISTS ai_usage (
  id serial PRIMARY KEY, user_id text, request_type text NOT NULL,
  tokens_estimate integer DEFAULT 0, created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS opportunities (
  id varchar(50) PRIMARY KEY, title text NOT NULL, summary text NOT NULL, details text,
  type varchar(50) NOT NULL, market varchar(50) NOT NULL, expected_return varchar(100),
  risk_level integer NOT NULL DEFAULT 3, sector varchar(100), duration varchar(100),
  deadline varchar(100), status varchar(30) NOT NULL DEFAULT 'active',
  featured boolean NOT NULL DEFAULT false, vip_only boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment_requests (
  id text PRIMARY KEY, phone text NOT NULL, name text NOT NULL, plan_key text NOT NULL,
  pay_method text NOT NULL DEFAULT '', price integer NOT NULL DEFAULT 0, tx text NOT NULL,
  status text NOT NULL DEFAULT 'pending', notes text, proof_image text, proof_name text,
  decided_at timestamptz,
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_requests_tx_method_uidx ON payment_requests (lower(tx), pay_method);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS user_notifications (
  id TEXT PRIMARY KEY, phone TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL, body TEXT NOT NULL, read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_notifications_phone_idx ON user_notifications (phone);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email text;
CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS password_resets (
  id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL, expires_at timestamp NOT NULL, used_at timestamp,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token_hash);
`;

/* ── 2) الإعدادات الافتراضية للدفع (لا تمس قيمك إن وُجدت) ─────────────────── */
const SETTINGS = [
  ["payment_vodafone_number", "01008605139"],
  ["payment_vodafone_instructions", "حوّل المبلغ على رقم المحفظة ثم ارفع صورة إثبات التحويل وأدخل رقم العملية."],
  ["payment_orange_number", ""],
  ["payment_orange_instructions", "حوّل المبلغ على رقم محفظة أورنج كاش ثم ارفع صورة إثبات التحويل وأدخل رقم العملية."],
  ["payment_etisalat_number", ""],
  ["payment_etisalat_instructions", "حوّل المبلغ على رقم محفظة اتصالات كاش ثم ارفع صورة إثبات التحويل وأدخل رقم العملية."],
  ["payment_instapay_number", ""],
  ["payment_instapay_instructions", "حوّل المبلغ عبر InstaPay (رقم المحفظة أو العنوان البنكي) ثم ارفع صورة إثبات التحويل وأدخل رقم العملية."],
  ["payment_vodafone_price", "99"],
];

/* جداول تُنسخ صفوفها عند --copy-data (المستهدف بالمعرف أو المفتاح) */
const COPY_TABLES = [
  ["app_users", "id"],
  ["employees", "id"],
  ["subscription_plans", "key"],
  ["coupons", "code"],
  ["opportunities", "id"],
  ["ai_config", "id"],
  ["app_settings", "key"],
];

async function main() {
  console.log("◆ الاتصال بالقاعدة السحابية…");
  await target.connect();
  await target.query(SCHEMA);
  for (const [k, v] of SETTINGS) {
    await target.query(`INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [k, v]);
  }
  const cfg = await target.query(`SELECT count(*)::int AS n FROM ai_config`);
  if (cfg.rows[0].n === 0) await target.query(`INSERT INTO ai_config DEFAULT VALUES`);
  console.log("✔ السكيمة كاملة + إعدادات الدفع جاهزة");

  if (!copyData) {
    console.log("ℹ لم تُنسخ البيانات. لنقل مستخدميك وخططك: أضف --copy-data (يتطلب PostgreSQL المحلي شغّالًا)");
    return;
  }

  console.log("◆ الاتصال بالقاعدة المحلية لنسخ البيانات…");
  await local.connect();
  for (const [table, keyCol] of COPY_TABLES) {
    const { rows } = await local.query(`SELECT * FROM ${table}`);
    if (!rows.length) {
      console.log(`  • ${table}: فارغ محليًا — تخطي`);
      continue;
    }
    const cols = Object.keys(rows[0]);
    let inserted = 0;
    for (const row of rows) {
      const vals = cols.map((c) => row[c]);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
      const r = await target.query(
        `INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})
         ON CONFLICT (${keyCol}) DO NOTHING`,
        vals,
      );
      inserted += r.rowCount ?? 0;
    }
    console.log(`  • ${table}: ${rows.length} صف محليًا، ${inserted} جديد أُدرج`);
  }
  console.log("✔ نسخ البيانات اكتمل");
}

main()
  .catch((e) => {
    console.error("✖ فشل:", e.message || e.code || e);
    if (/ECONNREFUSED|ENOTFOUND|timeout/i.test(String(e.message || e.code))) {
      console.error("  تأكد أن رابط Neon مكتوب صح وبين علامتي اقتباس، وإن النت شغال.");
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await target.end(); } catch {}
    try { await local.end(); } catch {}
  });
