#!/usr/bin/env node
/**
 * Safe PostgreSQL logical backup for a self-hosted EgyTrend deployment.
 *
 * Why pg_dump rather than hand-written INSERT statements?
 * pg_dump preserves schema, constraints, indexes, sequences, and data under
 * one consistent PostgreSQL snapshot. A partial/table-by-table export is not
 * a recovery-grade backup and is intentionally no longer used here.
 *
 * Commands:
 *   DATABASE_URL=... node scripts/backup-db.mjs
 *   node scripts/backup-db.mjs --verify backups/egytrend-YYYYMMDD.sql.gz
 *
 * The normal command writes a plain SQL gzip file with restrictive permissions.
 * It never falls back to a localhost/default database: DATABASE_URL is required.
 * Restore is intentionally a separate, explicitly-confirmed command in
 * scripts/restore-db.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BACKUP_DIR = path.join(ROOT, "backups");
const KEEP_DAYS = 7;
const LOCK = path.join(BACKUP_DIR, ".backup.lock");
const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const PG_DUMP_BIN = process.env.PG_DUMP_BIN || "pg_dump";

/* ── Optional at-rest encryption ───────────────────────────────────────────
 * A plain gzip backup is readable by anything that can read the file — on
 * Windows the Unix-style 0o600 permissions are NOT enforced, so a same-user
 * process (including malware) can open the dump directly. When a key is
 * configured the backup is wrapped in AES-256-GCM:
 *   format: [16-byte IV][ciphertext][16-byte GCM auth tag]
 * The GCM tag makes any tamper or truncation detectable at --verify time.
 *
 *   EGYTREND_BACKUP_KEY     64 hex chars / 44 base64 chars = raw 32-byte key
 *                           (generate: openssl rand -hex 32)
 *                           any other value is treated as a passphrase and
 *                           reduced to a 32-byte key with SHA-256
 *   EGYTREND_BACKUP_KEYFILE path to a file containing the key (preferred on
 *                           Windows: the key then never sits in the task's
 *                           environment)
 * Without a key the script still writes the legacy plain .sql.gz (so an
 * existing daily task never breaks) but logs a loud warning.
 */
const ENC_SUFFIX = ".enc";

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

function encryptFile(src, dst, key) {
  const data = fs.readFileSync(src);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  fs.writeFileSync(dst, Buffer.concat([iv, ct, cipher.getAuthTag()]), { mode: 0o600 });
}

function decryptFile(file, key) {
  const raw = fs.readFileSync(file);
  if (raw.length < 32) throw new Error("encrypted backup is truncated");
  const iv = raw.subarray(0, 16);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(16, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error("decryption failed — wrong key or corrupted/tampered backup");
  }
}

function usage() {
  console.log(`Usage:
  DATABASE_URL=postgresql://... node scripts/backup-db.mjs
  node scripts/backup-db.mjs --verify backups/egytrend-YYYYMMDD.sql.gz

Environment:
  DATABASE_URL             Required for a new backup; never written to logs.
  PG_DUMP_BIN              Optional absolute path to pg_dump (default: pg_dump).
  EGYTREND_BACKUP_KEY      Optional: 32-byte key (64 hex chars) or passphrase.
  EGYTREND_BACKUP_KEYFILE  Optional: path to a file holding the key (preferred).
`);
}

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
}

function log(message) {
  ensureBackupDir();
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  fs.appendFileSync(path.join(BACKUP_DIR, "backup.log"), `${line}\n`, { encoding: "utf8", mode: 0o600 });
}

function sqlName(date) {
  const two = (n) => String(n).padStart(2, "0");
  return `egytrend-${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}.sql.gz`;
}

function redact(message) {
  return String(message)
    .replace(/(?:postgres(?:ql)?:\/\/)[^\s'"`]+/gi, "<database-url-redacted>")
    .replace(/password\s*=\s*[^\s,;]+/gi, "password=<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

/** Convert the required URL into libpq env vars, keeping credentials out of
 * the pg_dump process argument list (and therefore out of process listings). */
function pgEnvironment(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid postgresql:// or postgres:// URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!database) throw new Error("DATABASE_URL must include a database name");

  const env = { ...process.env, PGDATABASE: database, PGCONNECT_TIMEOUT: "20" };
  if (url.hostname) env.PGHOST = url.hostname;
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);

  const queryToEnv = {
    sslmode: "PGSSLMODE",
    sslrootcert: "PGSSLROOTCERT",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
    application_name: "PGAPPNAME",
    connect_timeout: "PGCONNECT_TIMEOUT",
    options: "PGOPTIONS",
  };
  for (const [key, envKey] of Object.entries(queryToEnv)) {
    const value = url.searchParams.get(key);
    if (value) env[envKey] = value;
  }
  return env;
}

function acquireLock() {
  ensureBackupDir();
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let age = 0;
    try { age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch { return false; }
    if (age <= LOCK_MAX_AGE_MS) {
      log("SKIP another backup process holds the lock");
      return false;
    }
    log("WARN removing a stale backup lock");
    fs.rmSync(LOCK, { force: true });
    return acquireLock();
  }
}

function releaseLock() {
  try { fs.rmSync(LOCK, { force: true }); } catch { /* best effort */ }
}

function collectStderr(stream) {
  let output = "";
  stream?.on("data", (chunk) => {
    if (output.length < 16_000) output += chunk.toString();
  });
  return () => output;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function checkDumpBuffer(gunzipped) {
  if (gunzipped.length < 64 || !/PostgreSQL database dump/i.test(gunzipped.subarray(0, 2048).toString("utf8"))) {
    throw new Error("gzip decompressed but does not look like a pg_dump plain-SQL backup");
  }
  return gunzipped.length;
}

async function verifyBackup(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`backup file does not exist: ${filePath}`);
  if (filePath.endsWith(ENC_SUFFIX)) {
    const key = loadBackupKey();
    if (!key) throw new Error(`${path.basename(filePath)} is encrypted but no EGYTREND_BACKUP_KEY/EGYTREND_BACKUP_KEYFILE is configured`);
    return checkDumpBuffer(zlib.gunzipSync(decryptFile(filePath, key)));
  }
  let bytes = 0;
  let head = "";
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (head.length < 2048) head += chunk.toString("utf8", 0, Math.min(chunk.length, 2048 - head.length));
      callback();
    },
  });
  await pipeline(fs.createReadStream(filePath), zlib.createGunzip(), sink);
  if (bytes < 64 || !/PostgreSQL database dump/i.test(head)) {
    throw new Error("gzip decompressed but does not look like a pg_dump plain-SQL backup");
  }
  return bytes;
}

async function runPgDump(tempPath, databaseUrl) {
  const child = spawn(PG_DUMP_BIN, [
    "--format=plain",
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--quote-all-identifiers",
  ], {
    env: pgEnvironment(databaseUrl),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr = collectStderr(child.stderr);
  const output = fs.createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
  const copy = pipeline(child.stdout, zlib.createGzip({ level: 9 }), output);
  const [{ code, signal }] = await Promise.all([waitForExit(child), copy]);
  if (code !== 0) {
    throw new Error(`pg_dump failed${signal ? ` (${signal})` : ` (exit ${code})`}: ${redact(stderr()) || "no diagnostic output"}`);
  }
}

function pruneOldBackups() {
  let deleted = 0;
  for (const file of fs.readdirSync(BACKUP_DIR)) {
    if (!/^egytrend-\d{8}\.sql\.gz(\.enc)?$/.test(file)) continue;
    const datePart = file.slice("egytrend-".length, "egytrend-".length + 8);
    const date = new Date(`${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) continue;
    if (Date.now() - date.getTime() > KEEP_DAYS * 24 * 60 * 60 * 1000) {
      fs.rmSync(path.join(BACKUP_DIR, file), { force: true });
      deleted += 1;
    }
  }
  if (deleted) log(`retention: deleted ${deleted} old backup(s)`);
}

async function backup() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required; refusing to guess a backup target");
  if (!acquireLock()) return;

  let tempPath = "";
  try {
    const key = loadBackupKey();
    const base = path.join(BACKUP_DIR, sqlName(new Date()));
    const target = key ? base + ENC_SUFFIX : base;
    if (fs.existsSync(target)) {
      const bytes = await verifyBackup(target);
      log(`SKIP existing backup verified: ${path.basename(target)} (${(bytes / 1024).toFixed(1)} KB uncompressed)`);
      return;
    }

    tempPath = `${target}.${process.pid}.partial`;
    const started = Date.now();
    await runPgDump(tempPath, databaseUrl);
    const bytes = await verifyBackup(tempPath);
    if (key) {
      // Encrypt in place; the plaintext dump never survives on disk.
      const encTemp = `${tempPath}.enc`;
      encryptFile(tempPath, encTemp, key);
      const roundTrip = await verifyBackup(encTemp); // decrypt + gunzip + GCM tag
      if (roundTrip !== bytes) throw new Error("encrypted backup round-trip size mismatch");
      fs.rmSync(tempPath, { force: true });
      tempPath = "";
      fs.renameSync(encTemp, target);
      fs.chmodSync(target, 0o600);
      log(`OK ${path.basename(target)}: ${(fs.statSync(target).size / 1024).toFixed(1)} KB encrypted, ${(bytes / 1024).toFixed(1)} KB uncompressed, ${Date.now() - started}ms`);
    } else {
      fs.renameSync(tempPath, target);
      fs.chmodSync(target, 0o600);
      log(`OK ${path.basename(target)}: ${(fs.statSync(target).size / 1024).toFixed(1)} KB compressed, ${(bytes / 1024).toFixed(1)} KB uncompressed, ${Date.now() - started}ms`);
      log("WARN plaintext backup — set EGYTREND_BACKUP_KEY so dumps are unreadable without the key");
    }
    pruneOldBackups();
  } finally {
    if (tempPath) fs.rmSync(tempPath, { force: true });
    releaseLock();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) return backup();
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return usage();
  if (args.length === 2 && args[0] === "--verify") {
    const bytes = await verifyBackup(path.resolve(process.cwd(), args[1]));
    console.log(`OK verified ${args[1]} (${(bytes / 1024).toFixed(1)} KB uncompressed)`);
    return;
  }
  usage();
  throw new Error("invalid arguments");
}

main().catch((error) => {
  try { log(`FATAL ${redact(error?.message || error)}`); } catch { console.error(`FATAL ${redact(error?.message || error)}`); }
  process.exitCode = 1;
});
