import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { aiUsageTable } from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* pg-mem intentionally does not implement PostgreSQL advisory locks. That is
 * useful here: a test database missing the lock primitive must produce an
 * unavailable reservation, never an admitted external-AI call or a partial
 * usage row. Lock contention itself remains a Preview PostgreSQL check. */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-only-ai-budget-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type MemoryDatabase = Awaited<ReturnType<typeof createMemoryDatabase>>;
let memory: MemoryDatabase;
let reserve: (
  userId: string,
  feature: string,
  tokensEstimate: number,
  trialDailyLimit?: number | null,
) => Promise<{ ok: true; rowId: number; engine: "gemini" | "anthropic" | "local" } | "limit" | "unavailable">;

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  const module = await import("./ai");
  reserve = module.__aiTest.reserveExternalAiRequest;
});

after(async () => {
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

test("external AI reservation fails closed when PostgreSQL advisory locking is unavailable", async () => {
  const outcome = await reserve("user:synthetic-ai", "chat-test-reserved", 100);
  assert.equal(outcome, "unavailable");
  const usage = await memory.db.select().from(aiUsageTable);
  assert.equal(usage.length, 0, "an unavailable reservation must not create a usage row or admit provider spend");
});
