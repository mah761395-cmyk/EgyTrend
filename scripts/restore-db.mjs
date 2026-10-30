#!/usr/bin/env node
/**
 * Restore a self-hosted logical backup produced by scripts/backup-db.mjs
 * (pg_dump plain-SQL gzip). This deployment (Vercel/Neon) uses the in-database
 * schema snapshots instead — see scripts/restore-from-backup.mjs for those.
 *
 * Safety model (TASK L: no restore of production data without explicit
 * permission — the permission is this explicit, confirmed CLI invocation):
 *
 *   • `--dry-run` (the default) inspects only: file size, gzip integrity,
 *     the dump header, and the CREATE TABLE statements it contains.
 *     It changes nothing and never connects to a database.
 *   • `--confirm-restore` requires DATABASE_URL and psql on PATH, takes a
 *     fresh pg_dump of the target first (written next to the incoming file
 *     as <name>.pre-restore-<ts>.sql.gz), and only then applies the dump
 *     (which was produced with --clean --if-exists and therefore replaces
 *     the schema contents).
 *
 * Credentials come from DATABASE_URL only and are redacted from logs.
 *
 * Commands:
 *   node scripts/restore-db.mjs --dry-run backups/egytrend-YYYYMMDD.sql.gz
 *   DATABASE_URL=postgresql://... node scripts/restore-db.mjs --confirm-restore backups/egytrend-YYYYMMDD.sql.gz
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";

const PG_DUMP_BIN = process.env.PG_DUMP_BIN || "pg_dump";
const PSQL_BIN = process.env.PSQL_BIN || "psql";

function usage() {
  console.log(`Usage:
  node scripts/restore-db.mjs --dry-run backups/egytrend-YYYYMMDD.sql.gz
  DATABASE_URL=postgresql://... node scripts/restore-db.mjs --confirm-restore backups/egytrend-YYYYMMDD.sql.gz

Environment:
  DATABASE_URL  Required for --confirm-restore; never written to logs.
  PG_DUMP_BIN   Optional path to pg_dump (default: pg_dump).
  PSQL_BIN      Optional path to psql (default: psql).`);
}

function redact(message) {
  return String(message)
    .replace(/(?:postgres(?:ql)?:\/\/)[^\s'"]+/gi, "<database-url-redacted>")
    .replace(/password\s*=\s*[^\s,;]+/gi, "password=<redacted>")
    .trim()
    .slice(0, 1200);
}

function pgEnvironment(databaseUrl) {
  const url = new URL(databaseUrl);
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
  return env;
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

async function inspect(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`backup file does not exist: ${filePath}`);
  let bytes = 0;
  let head = "";
  const createTableStatements = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      const text = chunk.toString("utf8");
      if (head.length < 2048) head += text.slice(0, 2048 - head.length);
      for (const line of text.split("\n")) {
        if (/^CREATE TABLE /i.test(line)) createTableStatements.push(line.trim().slice(0, 160));
      }
      callback();
    },
  });
  await pipeline(fs.createReadStream(filePath), zlib.createGunzip(), sink);
  if (bytes < 64 || !/PostgreSQL database dump/i.test(head)) {
    throw new Error("gzip decompressed but does not look like a pg_dump plain-SQL backup");
  }
  return { bytes, tables: createTableStatements.length, sample: createTableStatements.slice(0, 10) };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--dry-run") {
    const info = await inspect(path.resolve(process.cwd(), args[1]));
    console.log(`DRY RUN — nothing was changed, no database was contacted.`);
    console.log(`File: ${args[1]}`);
    console.log(`Uncompressed size: ${(info.bytes / 1024).toFixed(1)} KB`);
    console.log(`CREATE TABLE statements: ${info.tables}`);
    for (const line of info.sample) console.log(`  ${line}`);
    console.log(`\nTo restore, re-run with --confirm-restore and DATABASE_URL set.`);
    return;
  }
  if (args.length === 3 && args[0] === "--confirm-restore") {
    const filePath = path.resolve(process.cwd(), args[1]);
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required for --confirm-restore");
    const info = await inspect(filePath);
    const preRestore = `${filePath}.pre-restore-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}.sql.gz`;
    console.log(`Verified ${info.tables} table(s) in the dump (${(info.bytes / 1024).toFixed(1)} KB uncompressed).`);
    console.log(`Taking a pre-restore dump to ${path.basename(preRestore)} ...`);
    const dumpChild = spawn(PG_DUMP_BIN, ["--format=plain", "--clean", "--if-exists", "--no-owner", "--no-privileges", "--quote-all-identifiers"], {
      env: pgEnvironment(databaseUrl),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const dumpStderr = collectStderr(dumpChild.stderr);
    const dumpOut = fs.createWriteStream(preRestore, { flags: "wx", mode: 0o600 });
    const dumpCopy = pipeline(dumpChild.stdout, zlib.createGzip({ level: 9 }), dumpOut);
    const [{ code, signal }] = await Promise.all([waitForExit(dumpChild), dumpCopy]);
    if (code !== 0) throw new Error(`pre-restore pg_dump failed${signal ? ` (${signal})` : ` (exit ${code})`}: ${redact(dumpStderr()) || "no diagnostic output"}`);
    console.log("Applying the dump ...");
    const sql = zlib.gunzipSync(fs.readFileSync(filePath)).toString("utf8");
    const psqlChild = spawn(PSQL_BIN, ["--single-transaction", "--quiet", "--on-error-stop"], {
      env: pgEnvironment(databaseUrl),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const psqlStderr = collectStderr(psqlChild.stderr);
    psqlChild.stdin.end(sql);
    const { code: restoreCode, signal: restoreSignal } = await waitForExit(psqlChild);
    if (restoreCode !== 0) {
      throw new Error(`restore failed${restoreSignal ? ` (${restoreSignal})` : ` (exit ${restoreCode})`}: ${redact(psqlStderr()) || "no diagnostic output"} — pre-restore dump kept at ${path.basename(preRestore)}`);
    }
    console.log(`OK: restore applied in one transaction. Pre-restore dump kept at ${path.basename(preRestore)}.`);
    return;
  }
  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`FATAL ${redact(error?.message || error)}`);
  process.exitCode = 1;
});
