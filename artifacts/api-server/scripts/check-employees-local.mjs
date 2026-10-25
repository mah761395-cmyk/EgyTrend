import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://postgres@localhost:5432/egytrend",
});

try {
  const r = await pool.query(
    "SELECT id, name, email, role, status, substr(password_hash,1,15) AS hash_head, last_login FROM employees ORDER BY id",
  );
  console.log("الموظفون الحاليون:");
  if (r.rows.length === 0) {
    console.log("  (لا يوجد موظفين)");
  }
  r.rows.forEach((row) =>
    console.log(
      `  ID: ${row.id} | الاسم: ${row.name} | البريد: ${row.email} | الدور: ${row.role} | الحالة: ${row.status} | هاش: ${row.hash_head} | آخر دخول: ${row.last_login}`,
    ),
  );
} catch (e) {
  console.error("فشل:", e.message);
  process.exit(1);
} finally {
  await pool.end();
}
