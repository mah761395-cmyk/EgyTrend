import assert from "node:assert/strict";
import test from "node:test";
import { withTimeout } from "./with-timeout";

test("withTimeout resolves with the fallback when the promise is slow", async () => {
  let resolved = false;
  const slow = new Promise<string>((resolve) => {
    setTimeout(() => {
      resolved = true;
      resolve("late");
    }, 120);
  });
  const value = await withTimeout(slow, 20, "fallback");
  assert.equal(value, "fallback");
  assert.equal(resolved, false, "the slow promise had not settled yet");
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(resolved, true, "the original promise keeps running so its late result still lands");
});

test("withTimeout returns the promise value when it settles first", async () => {
  const value = await withTimeout(Promise.resolve("fast"), 50, "fallback");
  assert.equal(value, "fast");
});
