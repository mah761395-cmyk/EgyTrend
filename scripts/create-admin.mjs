#!/usr/bin/env node
/**
 * Preview/Test-only first-admin bootstrap.
 *
 * Secrets are read from environment variables rather than CLI arguments and
 * are never echoed. This script never resets an existing account, never uses
 * a localhost/default URL, and refuses production; a production bootstrap is
 * an approved operator action with its own access/backup evidence.
 *
 * DATABASE_URL=... ADMIN_BOOTSTRAP_EMAIL=... ADMIN_BOOTSTRAP_PASSWORD=... \
 *   node scripts/create-admin.mjs --environment preview --yes-create-admin
 */
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "lib", "db", "package.json"));
const { Client } = require("pg");
const environment = String(process.argv[process.argv.indexOf("--environment") + 1] || "").toLowerCase();
const confirmed = process.argv.includes("--yes-create-admin");
const email = String(process.env.ADMIN_BOOTSTRAP_EMAIL || "").trim().toLowerCase();
const password = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || "");

function fail(message) {
  console.error(`Refusing admin bootstrap: ${message}`);
  process.exitCode = 1;
}

if (!process.env.DATABASE_URL) fail("DATABASE_URL is required and is never printed.");
else if (process.env.NODE_ENV === "production" || environment === "production") fail("this helper is Preview/Test-only; use the approved production bootstrap procedure.");
else if (!['preview', 'test'].includes(environment)) fail("pass --environment preview or --environment test.");
else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail("ADMIN_BOOTSTRAP_EMAIL must be a valid email address.");
else if (password.length < 12) fail("ADMIN_BOOTSTRAP_PASSWORD must be at least 12 characters.");
else if (!confirmed) fail("review the target database then repeat with --yes-create-admin.");
else {
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
  const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: "egytrend-safe-admin-bootstrap" });
  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock(843912609)");
    const existing = await client.query("SELECT id FROM employees WHERE email = $1 LIMIT 1", [email]);
    if (existing.rowCount) throw new Error("an employee with this email already exists; refuse password/role overwrite");
    await client.query(
      "INSERT INTO employees (name, email, role, status, password_hash, permissions) VALUES ($1, $2, $3, $4, $5, $6)",
      ["مدير النظام", email, "super_admin", "active", passwordHash, JSON.stringify([])],
    );
    console.log(`Created one super_admin in the declared ${environment} database.`);
  } catch (error) {
    fail(error instanceof Error ? error.message : "unknown bootstrap error");
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(843912609)"); } catch { /* best effort */ }
    await client.end();
  }
}
