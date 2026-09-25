// One-off: create/refresh a super_admin employee account.
// Usage: bun create-admin.mjs <email> <password> [DATABASE_URL]
// No defaults: credentials must never live in source control.
import { Pool } from "pg";
import crypto from "crypto";

const EMAIL = process.argv[2];
const PASSWORD = process.argv[3];
if (!EMAIL || !PASSWORD || PASSWORD.length < 10) {
  console.error("usage: bun create-admin.mjs <email> <password(10+ chars)> [DATABASE_URL]");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.argv[4] || process.env.DATABASE_URL || "postgres://postgres@localhost:5432/egytrend",
});

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

try {
  const hash = hashPassword(PASSWORD);
  const existing = await pool.query("SELECT id FROM employees WHERE email=$1", [EMAIL]);
  if (existing.rows.length) {
    await pool.query(
      "UPDATE employees SET name=$1, role=$2, status=$3, password_hash=$4, updated_at=NOW() WHERE email=$5",
      ["المدير العام", "super_admin", "active", hash, EMAIL],
    );
    console.log("UPDATED existing super_admin:", EMAIL);
  } else {
    await pool.query(
      "INSERT INTO employees (name, email, role, status, password_hash, permissions) VALUES ($1,$2,$3,$4,$5,$6)",
      ["المدير العام", EMAIL, "super_admin", "active", hash, JSON.stringify([])],
    );
    console.log("CREATED super_admin:", EMAIL);
  }
  const all = await pool.query("SELECT id, name, email, role, status FROM employees ORDER BY id");
  console.log("Employees now:", JSON.stringify(all.rows));
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
