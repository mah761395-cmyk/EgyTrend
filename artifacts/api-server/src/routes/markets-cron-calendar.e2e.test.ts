import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createMemoryDatabase } from "../test-support/memory-db";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "markets-cron-test-session-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

/* The daily-snapshot cron and the FxPro+CBE calendar are exercised through
 * the real app: the cron authentication (vercel-cron markers) must not
 * depend on a secret, and the calendar must serve the embedded CBE schedule
 * even when the syndication feed is unreachable. */

type Memory = Awaited<ReturnType<typeof createMemoryDatabase>>;
let memory: Memory;
let server: http.Server;
let baseUrl = "";

async function raw(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON only asserted on in failure branches */
  }
  return { status: response.status, body };
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: unknown }).__egytrendTestDatabase;
});

test("the daily snapshot GET is only for the vercel-cron platform identity", async () => {
  // No vercel-cron markers at all -> hidden (404, not 401/403).
  const anonymous = await raw("/api/markets/internal/daily-snapshot", {
    headers: { "User-Agent": "curl/8.0" },
  });
  assert.equal(anonymous.status, 404);

  // The user agent alone is not enough.
  const uaOnly = await raw("/api/markets/internal/daily-snapshot", {
    headers: { "User-Agent": "vercel-cron/1.0" },
  });
  assert.equal(uaOnly.status, 404);

  // Without a cron secret the POST path stays locked too.
  const post = await raw("/api/markets/internal/daily-snapshot", { method: "POST" });
  assert.equal(post.status, 404);
});

test("the vercel-cron GET runs the job and reports the write gate honestly", async () => {
  // MARKET_SNAPSHOT_WRITES_ENABLED is not set here: the job must acknowledge
  // (not 404) and report the skip instead of writing history.
  const scheduled = await raw("/api/markets/internal/daily-snapshot", {
    headers: {
      "User-Agent": "vercel-cron/1.0",
      "x-vercel-cron-schedule": "55 14 * * 0-4",
    },
  });
  assert.equal(scheduled.status, 409);
  assert.equal(scheduled.body?.status, "skipped");
});

test("the calendar serves the FxPro feed merged with the CBE schedule", async () => {
  // When the syndication feed is reachable it spans two weeks (~60-90
  // upcoming events) and the CBE rows must survive the payload cap; when it
  // is not (isolated test network) the embedded CBE schedule stands alone.
  const { status, body } = await raw("/api/markets/calendar");
  assert.equal(status, 200);
  assert.equal(body?.status, "ok");
  assert.ok(Array.isArray(body?.events) && body.events.length > 0, "calendar is not empty");
  const cbe = body.events.filter((event: any) => event.countryAr === "مصر");
  assert.ok(cbe.length >= 1, "CBE MPC meetings are present (not truncated by the cap)");
  assert.ok(cbe.every((event: any) => event.imp === "عالي"), "CBE meetings are high impact");
  const feed = body.events.filter((event: any) => event.source === "FxPro Economic Calendar");
  if (feed.length > 0) {
    assert.ok(body.events.length >= feed.length + cbe.length, "feed and CBE events are merged");
  }
  // Attribution always names the earliest event's source (feed or CBE).
  assert.equal(body.source, body.events[0]?.source ?? "غير متاح");
  assert.notEqual(body.source, "غير متاح");
});
