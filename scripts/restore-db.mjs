#!/usr/bin/env node
/**
 * Explicit, separately-confirmed restore for EgyTrend backups.
 *
 * A restore is deliberately NOT part of the daily backup task and is not
 * triggered by anything in the repository. It exists so recovery is a
 * reviewed, typed-in command instead of an accident:
 *
 *   node scripts/restore-db.mjs --verify backups/egytrend-20261030.sql.gz
 *   node scripts/restore-db.mjs --verify backups/egytrend-20261030.sql.gz.enc
 *   node scripts/restore-db.mjs --target "postgresql://..." \
 *        --confirm eg-trend-test backups/egytrend-20261030.sql.gz
 *
 * Safeguards:
 *   - the target must be typed twice: the full URL and its database name
 *     via --confirm;
 *   - restoring into the same host+database as DATABASE_URL (the live
 *     production database) is REFUSED unless --confirm-prod is also passed;
 *   - encrypted backups (.enc) require EGYTREND_BACKUP_KEY/KEYFILE and
 *     fail closed on a bad key or any tampering (GCM auth tag);
 *   - credentials are passed to psql through environment variables, never
 *     through the process argument list.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BACKUP_DIR = path.join(ROOT, "backups");
const ENC_SUFFIX = ".enc";

function usage() {
  console.log(`Usage:
  node scripts/restore-db.mjs --verify <backup-file>
  node scripts/restore-db.mjs --target "postgresql://user:pass@host:5432/db" \\
       --confirm <db-name> [--confirm-prod] <backup-file>

Environment:
  EGYTREND_BACKUP_KEY / EGYTREND_BACKUP_KEYFILE   required for .enc backups
  PSQL_BIN                                        optional path to psql (default: psql)
`);
}

function loadBackupKey() {
  let material = process.env.EGYTREND_BACKUP_KEY || "";
  const keyfile = process.env.EGYTREND_BACKUP_KEYFILE || "";
  if (keyfile) {
    try { material = fs.readFileSync(keyfile, "utf8"); }
    catch { throw new Error("EGYTREND_BACKUP_KEYFILE is set but unreadable"); }
  }
  material = material.trim();
  if (!material) return null;
  if (/^[0-9a-fA-F]{64}$/.test(material)) return Buffer.from(material, "hex");
  if (/^[A-Za-z0-9+/]{43,44}={0,2}$/.test(material)) return Buffer.from(material, "base64");
  return crypto.createHash("sha256").update(material).digest();
}

function decryptFile(file, key) {
  const raw = fs.readFileSync(file);
  if (raw.length < 32) throw new Error("encrypted backup is truncated");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 16));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  try {
    return Buffer.concat([decipher.update(raw.subarray(16, raw.length - 16)), decipher.final()]);
  } catch {
    throw new Error("decryption failed — wrong key or corrupted/tampered backup");
  }
}

function readDumpSql(file) {
  if (!fs.existsSync(file)) throw new Error(`backup file does not exist: ${file}`);
  const gz = file.endsWith(ENC_SUFFIX)
    ? decryptFile(file, loadBackupKey() || (() => { throw new Error("encrypted backup but no key configured"); })())
    : fs.readFileSync(file);
  const sql = zlib.gunzipSync(gz);
  if (sql.length < 64 || !/PostgreSQL database dump/i.test(sql.subarray(0, 2048).toString("utf8"))) {
    throw new Error("decompressed content does not look like a pg_dump plain-SQL backup");
  }
  return sql;
}

function sqlNameFromUrl(url) {
  try {
    const u = new URL(url);
    if (!["postgres:", "postgresql:"].includes(u.protocol)) throw new Error("bad protocol");
    return { db: decodeURIComponent(u.pathname.replace(/^\/+/, "")) || null, host: u.hostname, port: u.port };
  } catch (error) {
    throw new Error(`invalid target URL: ${error.message}`);
  }
}

function pgEnvironment(url) {
  const u = new URL(url);
  const env = { ...process.env, PGPASSWORD: undefined };
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  if (u.hostname) env.PGHOST = u.hostname;
  if (u.port) env.PGPORT = u.port;
  env.PGDATABASE = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
  env.PGCONNECT_TIMEOUT = "30";
  for (const [k, v] of Object.entries({ sslmode: "PGSSLMODE", sslrootcert: "PGSSLROOTCERT", sslcert: "PGSSLCERT", sslkey: "PGSSLKEY" })) {
    const val = u.searchParams.get(k);
    if (val) env[v] = val;
  }
  return env;
}

function runPs(url, sqlFile, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PSQL_BIN || "psql", opts, { env: pgEnvironment(url), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stderr.on("data", (c) => { if (out.length < 8000) out += c.toString(); });
    child.stdin?.on?.("error", () => {});
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, out }));
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    usage();
    if (!args.length) process.exitCode = 1;
    return;
  }

  /* --verify <file>: integrity only, no database touched. */
  if (args[0] === "--verify" && args.length === 2) {
    const file = path.resolve(process.cwd(), args[1]);
    const sql = readDumpSql(file);
    console.log(`OK verified ${args[1]} (${(sql.length / 1024).toFixed(1)} KB of SQL${file.endsWith(ENC_SUFFIX) ? ", decrypted, GCM tag valid" : ""})`);
    return;
  }

  /* --target <url> --confirm <db> [--confirm-prod] <file> */
  if (args[0] === "--target" && args.length >= 4) {
    const target = args[1];
    let confirm = "";
    let confirmProd = false;
    let file = "";
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--confirm") confirm = args[++i] || "";
      else if (args[i] === "--confirm-prod") confirmProd = true;
      else if (!file) file = args[i];
    }
    const t = sqlNameFromUrl(target);
    if (!file || !confirm || !t.db) {
      usage();
      throw new Error("restore needs: --target <url>, --confirm <database-name> and the backup file");
    }
    if (confirm !== t.db) throw new Error(`--confirm must equal the target database name (${t.db ? "name hidden — compare against the URL you typed" : "?"})`);

    const prodUrl = process.env.DATABASE_URL;
    if (prodUrl) {
      try {
        const p = new URL(prodUrl);
        if (p.hostname === t.host && (p.pathname.replace(/^\/+/, "") || null) === t.db) {
          if (!confirmProd) {
            throw new Error("refusing: target looks like the LIVE production database (matches DATABASE_URL). Use a disposable test database for restore drills, or add --confirm-prod if a real production restore is truly intended and a current backup exists.");
          }
          console.error("DANGER: restoring into the LIVE production database.");
        }
      } catch (error) {
        if (/refusing/.test(error.message)) throw error;
      }
    }

    const absFile = path.resolve(process.cwd(), file);
    console.error(`About to restore ${path.basename(absFile)} into ${t.host}:${t.port || 5432}/${t.db} — existing content there is overwritten.`);
    console.error("This is a plain pg_dump restore with --clean --if-exists: it drops and recreates objects named in the dump.");

    const { code, signal, out } = await runPs(target, absFile, [
      "-v", "ON_ERROR_STOP=1",
      "--single-transaction",
      "--clean",
      "--if-exists",
      "-f", absFile,
    ]);
    if (code !== 0) {
      const tail = out.trim().split("\n").slice(-5).join(" | ");
      throw new Error(`psql failed${signal ? ` (${signal})` : ` (exit ${code})`}: ${tail || "no output"}`);
    }
    console.log(`OK restore completed into ${t.host}:${t.port || 5432}/${t.db}`);
    return;
  }

  usage();
  throw new Error("invalid arguments");
}

main().catch((error) => {
  console.error(`FATAL ${error?.message || error}`);
  process.exitCode = 1;
});
