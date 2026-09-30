/* Idempotent migration: multi-method payment (vodafone / orange / etisalat / instapay)
 * 1) payment_requests.decided_at  → decision timestamp (pending-age alerts + user notifications)
 * 2) app_settings defaults for every method: number + instructions
 * Run: bun scripts/migrate-pay-methods.mjs
 */
import path from "path";
import { createRequire } from "module";
const { Client } = createRequire(path.resolve(import.meta.dir, "../lib/db/package.json"))("pg");

const DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@localhost:5432/egytrend";
const client = new Client({ connectionString: DATABASE_URL });

async function main() {
  await client.connect();
  await client.query(`ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await client.query(`CREATE INDEX IF NOT EXISTS user_notifications_phone_idx ON user_notifications (phone)`);;

  /* method|number|label entries — empty number keeps the method hidden from users
   * until the admin fills it in. Vodafone ships enabled with the known wallet. */
  const defaults = [
    ["payment_vodafone_number", "01008605139"],
    ["payment_vodafone_instructions", "حوّل المبلغ على رقم المحفظة ثم ارفع صورة إثبات التحويل وأدخل رقم العملية."],
    ["payment_orange_number", ""],
    ["payment_orange_instructions", "حوّل المبلغ على رقم محفظة أورنج كاش ثم ارفع صورة إثبات التحويل وأدخل رقم العملية."],
    ["payment_etisalat_number", ""],
    ["payment_etisalat_instructions", "حوّل المبلغ على رقم محفظة اتصالات كاش ثم ارفع صورة إثبات التحويل وأدخل رقم العملية."],
    ["payment_instapay_number", ""],
    ["payment_instapay_instructions", "حوّل المبلغ عبر InstaPay (رقم المحفظة أو العنوان البنكي) ثم ارفع صورة إثبات التحويل وأدخل رقم العملية."],
  ];
  for (const [key, value] of defaults) {
    await client.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value],
    );
  }

  const col = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='payment_requests' AND column_name='decided_at'`);
  console.log(`OK migrate-pay-methods: decided_at (${col.rowCount}) + ${defaults.length} method settings ready`);
}

main()
  .catch((e) => { console.error("MIGRATION FAILED:", e); process.exitCode = 1; })
  .finally(() => client.end());
