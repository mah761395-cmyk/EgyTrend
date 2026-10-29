import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { dbBackupsTable, employeesTable } from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* TASK L C3 — database backups (on-demand + cron) on the in-database schema
 * snapshot mechanism.
 *
 * pg-mem cannot hold schema snapshots (no CTAS/INSERT..SELECT support), so
 * the test asserts the HONESTY contract end to end:
 *   • creation attempts fail closed (503 backup_unavailable) and record
 *     NOTHING in the ledger — no fake "backup ok";
 *   • the ledger read API reports what exists (schemaPresent live check);
 *   • the "last verified backup" rule is unit-tested on the pure selector;
 *   • the cron entry point mirrors the markets cron auth (secret or
 *     vercel-cron markers; 404 otherwise) and skip-if-recent guard.
 * The real snapshot/restore SQL path is exercised in production via the
 * admin endpoint + scripts/restore-from-backup.mjs --dry-run. */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-only-backups-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";
process.env.MARKET_SNAPSHOT_CRON_SECRET = "test-only-backups-cron-secret";

type MemoryDatabase = Awaited<ReturnType<typeof createMemoryDatabase>>;
let memory: MemoryDatabase;
let server: http.Server;
let baseUrl = "";

function employeePasswordHash(password: string): string {
  const salt = "00112233445566778899aabbccddeeff";
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

type CookieJar = { value?: string };

async function api(path: string, jar: CookieJar, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", baseUrl);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (jar.value) headers.set("Cookie", jar.value);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) jar.value = setCookie.split(";")[0];
  const raw = await response.text();
  let body: Record<string, unknown> | null = null;
  try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { /* non-JSON */ }
  return { response, body, raw };
}

async function adminLogin(email: string, password: string): Promise<CookieJar> {
  const jar: CookieJar = {};
  const r = await api("/api/admin/login", jar, { method: "POST", body: JSON.stringify({ email, password }) });
  assert.equal(r.response.status, 200, `admin login failed for ${email}`);
  return jar;
}

const SUPER_ADMIN = { email: "super.bk@example.test", password: "SuperBkSynth1!" };
const ADMIN = { email: "admin.bk@example.test", password: "AdminBkSynth1!" };
const SUPPORT = { email: "support.bk@example.test", password: "SupportBkSynth1!" };

let superJar: CookieJar;
let adminJar: CookieJar;
let supportJar: CookieJar;

type BackupsApi = typeof import("../lib/db-backups");
let backups: BackupsApi;

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;

  await memory.db.insert(employeesTable).values([
    { name: "Bk Super", email: SUPER_ADMIN.email, role: "super_admin", status: "active", passwordHash: employeePasswordHash(SUPER_ADMIN.password) },
    { name: "Bk Admin", email: ADMIN.email, role: "admin", status: "active", passwordHash: employeePasswordHash(ADMIN.password) },
    { name: "Bk Support", email: SUPPORT.email, role: "support", status: "active", passwordHash: employeePasswordHash(SUPPORT.password) },
  ]);

  backups = await import("../lib/db-backups");

  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;

  superJar = await adminLogin(SUPER_ADMIN.email, SUPER_ADMIN.password);
  adminJar = await adminLogin(ADMIN.email, ADMIN.password);
  supportJar = await adminLogin(SUPPORT.email, SUPPORT.password);
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

test("POST /api/admin/backups fails closed in an environment without a real pool — no fake success", async () => {
  const r = await api("/api/admin/backups", superJar, { method: "POST", body: "{}" });
  assert.equal(r.response.status, 503, JSON.stringify(r.body));
  assert.equal(r.body?.message, "backup_unavailable");
  const ledger = await memory.db.select().from(dbBackupsTable);
  assert.equal(ledger.length, 0, "no ledger row for a backup that was never made");
  assert.ok(!r.raw.includes("test-only-backups-secret-not-for-deployment"), "no secrets in the response");
});

test("GET /api/admin/backups: empty ledger, honest lastVerifiedBackup", async () => {
  const r = await api("/api/admin/backups", adminJar);
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body?.rows, []);
  assert.equal(r.body?.lastVerifiedBackup, null, "never a backup before any backup");
});

test("seeded ledger row is listed; schemaPresent is a live check (false here); never 'last verified'", async () => {
  await memory.db.insert(dbBackupsTable).values([
    { schemaName: "egytrend_backup_20261028T033000", tableCount: 42, kind: "cron", createdBy: null, verified: true, note: null },
  ]);
  const r = await api("/api/admin/backups", adminJar);
  assert.equal(r.response.status, 200);
  const rows = r.body?.rows as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].schemaName, "egytrend_backup_20261028T033000");
  assert.equal(rows[0].verified, true);
  assert.equal(rows[0].schemaPresent, false, "pg-mem holds no schemas — the live check reports the truth");
  assert.equal(r.body?.lastVerifiedBackup, null, "an unverifiable backup is not the last successful one");
});

test("cron entry point: 404 without credentials, skip-if-recent, then honest 503", async () => {
  const none = await api("/api/backups/cron", {}, {});
  assert.equal(none.response.status, 404, "unauthenticated → not found (existence not advertised)");

  const wrong = await api("/api/backups/cron", {}, {
    method: "POST",
    headers: { "x-cron-secret": "wrong-secret" },
  });
  assert.equal(wrong.response.status, 404);

  /* The seeded row is recent → the authorized job skips instead of
     double-spending a snapshot. */
  const skip = await api("/api/backups/cron", {}, {
    method: "POST",
    headers: { "x-cron-secret": process.env.MARKET_SNAPSHOT_CRON_SECRET! },
  });
  assert.equal(skip.response.status, 200, JSON.stringify(skip.body));
  assert.equal(skip.body?.action, "skipped");
  assert.ok(typeof skip.body?.reason === "string", "skip reason is reported");

  /* Age the seeded row past the interval → the job attempts the backup and
     fails closed (no real pool in this environment), recording nothing. */
  const rows = await memory.db.select().from(dbBackupsTable);
  await memory.db.update(dbBackupsTable).set({ createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) }).where(eq(dbBackupsTable.id, rows[0].id));
  const secret = await api("/api/backups/cron", {}, {
    method: "POST",
    headers: { "x-cron-secret": process.env.MARKET_SNAPSHOT_CRON_SECRET! },
  });
  assert.equal(secret.response.status, 503, `authorized job, no real pool → honest 503; got ${JSON.stringify(secret.body)}`);
  assert.equal(secret.body?.message, "backup_unavailable");

  const vercel = await api("/api/backups/cron", {}, {
    headers: { "user-agent": "vercel-cron", "x-vercel-cron-schedule": "30 3 * * *" },
  });
  assert.equal(vercel.response.status, 503, `vercel-cron markers authorize; job still fails closed; got ${JSON.stringify(vercel.body)}`);

  const ledger = await memory.db.select().from(dbBackupsTable);
  assert.equal(ledger.length, 1, "failed cron jobs record nothing");
});

test("permissions: backup management is admin+, staff denied", async () => {
  const read = await api("/api/admin/backups", supportJar);
  assert.equal(read.response.status, 403);
  const create = await api("/api/admin/backups", supportJar, { method: "POST", body: "{}" });
  assert.equal(create.response.status, 403);
  const noAuth = await api("/api/admin/backups", {});
  assert.equal(noAuth.response.status, 401);
});

test("pickLastVerifiedBackup: verified AND schema-present, newest first", () => {
  const rows = [
    { id: 3, verified: true, schemaPresent: false, createdAt: new Date(3) },
    { id: 2, verified: true, schemaPresent: true, createdAt: new Date(2) },
    { id: 1, verified: false, schemaPresent: true, createdAt: new Date(1) },
  ];
  assert.equal(backups.pickLastVerifiedBackup(rows)?.id, 2, "unverified or schema-missing rows never win");
  assert.equal(backups.pickLastVerifiedBackup(rows.slice(0, 1)), null, "no candidate → null");
  assert.equal(backups.pickLastVerifiedBackup([]), null);
});

test("parseBackupTimestamp: prod-format names, suffixes, and garbage", () => {
  const prod = backups.parseBackupTimestamp("egytrend_backup_20261029T012006");
  assert.ok(prod && prod.toISOString() === "2026-10-29T01:20:06.000Z");
  const suffixed = backups.parseBackupTimestamp("egytrend_backup_20261029T012006_2");
  assert.ok(suffixed && suffixed.toISOString() === "2026-10-29T01:20:06.000Z");
  assert.equal(backups.parseBackupTimestamp("public"), null);
  assert.equal(backups.parseBackupTimestamp("egytrend_backup_garbage"), null);
});

test("shouldSkipBackup: recent backup suppresses, an old one does not", async () => {
  /* The only row was aged 30 days in the previous test → no skip. */
  const noSkip = await backups.shouldSkipBackup();
  assert.equal(noSkip.skip, false);

  /* A fresh backup (any kind) within the window → skip. */
  await memory.db.insert(dbBackupsTable).values([
    { schemaName: "egytrend_backup_20261029T220000", tableCount: 42, kind: "manual", createdBy: "Bk Admin", verified: true },
  ]);
  const skip = await backups.shouldSkipBackup();
  assert.equal(skip.skip, true);
  assert.ok(typeof skip.reason === "string" && /h/.test(skip.reason), "skip reason mentions the window");
});
