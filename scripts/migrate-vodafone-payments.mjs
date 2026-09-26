/* One-off idempotent migration for the Vodafone Cash VIP subscription flow:
 * 1) payment_requests: +proofImage (data URL ≤ ~290KB), proofName, re-check notes
 * 2) unique index on (tx, pay_method) → same transfer number can NEVER be
 *    reused, even from two devices racing at the same millisecond
 * 3) app_settings: editable payment price + Vodafone Cash wallet number
 * Run: bun scripts/migrate-vodafone-payments.mjs
 */
import path from "path";
import { createRequire } from "module";
const { Client } = createRequire(path.resolve(import.meta.dir, "../lib/db/package.json"))("pg");

const DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@localhost:5432/egytrend";
const client = new Client({ connectionString: DATABASE_URL });

async function main() {
  await client.connect();

  await client.query(`ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS proof_image TEXT`);
  await client.query(`ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS proof_name TEXT`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS payment_requests_tx_method_uidx ON payment_requests (lower(tx), pay_method)`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const defaults = [
    ["payment_vodafone_number", "01008605139"],
    ["payment_vodafone_price", "99"],
    ["payment_instructions", "حوّل المبلغ على رقم المحفظة ثم ارفع صورة إثبات التحويل وأدخل رقم العملية."],
  ];
  for (const [key, value] of defaults) {
    await client.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value],
    );
  }

  const idx = await client.query(`SELECT indexname FROM pg_indexes WHERE indexname = 'payment_requests_tx_method_uidx'`);
  console.log(`OK migrate-vodafone-payments: columns + unique index (${idx.rowCount}) + settings ready`);
}

main()
  .catch((e) => { console.error("MIGRATION FAILED:", e); process.exitCode = 1; })
  .finally(() => client.end());
