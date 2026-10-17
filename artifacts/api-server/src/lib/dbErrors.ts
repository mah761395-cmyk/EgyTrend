/* ─── Database error classification shared by server workflows ───────────
 * Drizzle wraps every driver failure in a `DrizzleQueryError` whose own
 * `message` only reads `Failed query: …`. The SQLSTATE code and the Postgres
 * message that name the violated constraint stay on the `cause` chain, so a
 * check against the top-level error alone never recognises a real duplicate:
 * idempotency guards keep rethrowing and user-facing routes answer 500 where
 * the duplicate should be a 409 (or a safe no-op).
 *
 * `isDuplicateKeyError` walks that chain and answers exactly one question:
 * did the database reject this statement because it would duplicate a value
 * that must stay unique? Nothing else is treated as a duplicate.
 * ═══════════════════════════════════════════════════════════════════════ */

/** SQLSTATE `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/** Postgres/Drizzle phrasings for a rejected duplicate value. */
const DUPLICATE_MESSAGE = /duplicate key|unique constraint|unique violation|unique index|_uidx\b/i;

/** Wrapped chains deeper than this are not inspected (defensive bound). */
const MAX_CAUSE_DEPTH = 5;

export function isDuplicateKeyError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (code === UNIQUE_VIOLATION) return true;
    if (typeof message === "string" && DUPLICATE_MESSAGE.test(message)) return true;
    if (cause === current) return false; // self-referencing chain: stop, never loop
    current = cause;
  }
  return false;
}
