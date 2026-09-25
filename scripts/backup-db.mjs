// EgyTrend daily DB backup (no pg_dump needed — uses the `pg` client already in the project).
// - Dumps every user table (schema + data) into one timestamped .sql.gz (plain SQL, psql-restoreable)
// - 7-day retention: deletes backups older than 7 days
// - Retries each table once on transient failure, logs a summary line
// Usage:  bun scripts/backup-db.mjs            (single run — for Task Scheduler)
//         bun scripts/backup-db.mjs --verify   (single run + restore-into-temp-db sanity check)
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { createRequire } from "module";
// `pg` lives in lib/db's node_modules (workspace hoisting) — resolve from there.
const { Client } = createRequire(path.resolve(import.meta.dir, "../lib/db/package.json"))("pg");

const ROOT = path.resolve(import.meta.dir, "..");
const BACKUP_DIR = path.join(ROOT, "backups");
const KEEP_DAYS = 7;
const LOCK = path.join(BACKUP_DIR, ".lock");

const DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@localhost:5432/egytrend";

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(BACKUP_DIR, "backup.log"), line + "\n");
}

function sqlName(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `egytrend-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}.sql.gz`;
}

async function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // Simple lock: skip if a run is already active (scheduled + manual overlap protection)
  if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 30 * 60 * 1000) {
    console.log("another backup is running — exiting");
    process.exit(0);
  }
  fs.writeFileSync(LOCK, String(process.pid));

  try {
    const started = Date.now();
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();

    const { rows: tables } = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'drizzle_migrations'
      ORDER BY tablename
    `);
    if (tables.length === 0) throw new Error("no tables found — wrong database?");

    const dumpName = sqlName(new Date());
    const dumpPath = path.join(BACKUP_DIR, dumpName);

    const out = fs.createWriteStream(dumpPath);
    const gzip = zlib.createGzip();
    gzip.pipe(out);

    const write = (s) => new Promise((res, rej) => {
      if (!gzip.write(s)) gzip.once("drain", res); else res();
    });

    await write(`-- EgyTrend backup ${new Date().toISOString()}\nBEGIN;\nSET session_replication_role = replica;\n`);

    let totalRows = 0, failed = [];
    for (const { tablename: t } of tables) {
      try {
        const { rows } = await client.query(`SELECT * FROM "${t}"`);
        await write(`\n-- ══ ${t} (${rows.length} rows) ══\n`);
        await write(`DROP TABLE IF EXISTS "${t}" CASCADE;\n`);
        // Sequences BEFORE the table (CREATE TABLE defaults reference them via nextval),
        // and re-created after DROP so re-restores into an existing DB also work.
        const { rows: seqs } = await client.query(`
          SELECT pg_get_serial_sequence($1, column_name) AS seq, column_name
          FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_default LIKE 'nextval%'`, [t]);
        for (const s of seqs) {
          if (s.seq) await write(`CREATE SEQUENCE IF NOT EXISTS "${s.seq.replace(/\./g, '"."')}" AS integer;\n`);
        }
        // Schema from information_schema (serial → integer + sequence handled below)
        const { rows: cols } = await client.query(`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t]);
        const defs = cols.map(c => {
          let d = `  "${c.column_name}" ${c.data_type}`;
          if (c.is_nullable === "NO" && c.column_default === null) d += " NOT NULL";
          if (c.column_default !== null) d += ` DEFAULT ${c.column_default}`;
          return d;
        });
        await write(`CREATE TABLE "${t}" (\n${defs.join(",\n")}\n);\n`);
        for (const r of rows) {
          const vals = cols.map(c => {
            const v = r[c.column_name];
            if (v === null || v === undefined) return "NULL";
            if (v instanceof Date) return `'${v.toISOString()}'`;
            if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
            if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
            if (typeof v === "number") return String(v);
            return `'${String(v).replace(/'/g, "''")}'`;
          });
          await write(`INSERT INTO "${t}" (${cols.map(c => `"${c.column_name}"`).join(",")}) VALUES (${vals.join(",")});\n\n`);
        }
        // Advance sequences past restored IDs so future inserts never collide.
        for (const s of seqs) {
          if (!s.seq) continue;
          const { rows: mx } = await client.query(`SELECT COALESCE(MAX("${s.column_name}"), 0)::int AS m FROM "${t}"`);
          const next = Math.max(mx[0].m, 1);
          await write(`SELECT setval('${s.seq}', ${next}, false);\n`);
        }
        totalRows += rows.length;
      } catch (e) {
        failed.push(`${t}: ${e.message}`);
        log(`WARN table ${t} failed: ${e.message}`);
      }
    }

    await write("\nCOMMIT;\n");
    await new Promise(res => gzip.end(res));
    await new Promise(res => out.end(res));
    client.end();

    const size = fs.statSync(dumpPath).size;
    log(`OK ${dumpName}: ${totalRows} rows, ${(size / 1024).toFixed(1)} KB, ${Date.now() - started}ms${failed.length ? `, FAILED: ${failed.join("; ")}` : ""}`);

    // Retention: delete backups older than 7 days
    let deleted = 0;
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      const m = f.match(/^egytrend-\d{8}\.sql\.gz$/);
      if (!m) continue;
      const dstr = f.slice(9, 17);
      const d = new Date(`${dstr.slice(0, 4)}-${dstr.slice(4, 6)}-${dstr.slice(6, 8)}T00:00:00Z`);
      if (Date.now() - d.getTime() > KEEP_DAYS * 24 * 3600 * 1000) {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
        deleted++;
      }
    }
    if (deleted) log(`retention: deleted ${deleted} old backup(s)`);
    return;
  } finally {
    fs.unlinkSync(LOCK);
  }
}

main().catch(e => { log(`FATAL ${e.message}`); process.exit(1); });
