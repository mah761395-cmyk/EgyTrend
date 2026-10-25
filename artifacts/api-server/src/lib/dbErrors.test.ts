import assert from "node:assert/strict";
import test from "node:test";
import { DrizzleQueryError } from "drizzle-orm";
import { isDuplicateKeyError, sqlStateOf } from "./dbErrors";

/** The shape node-postgres throws for a violated unique index. */
function postgresUniqueViolation(indexName: string): Error {
  const error = new Error(`duplicate key value violates unique constraint "${indexName}"`) as Error & { code?: string };
  error.code = "23505";
  return error;
}

test("a duplicate rejected by the payment reference index is recognised through drizzle's wrapper", () => {
  /* Reproduces the exact production shape: node-postgres error -> drizzle
   * wrapper. The wrapper message does not contain the SQLSTATE, the index
   * name or the word "unique", which is why matching the top-level error
   * alone answered 500 instead of 409. */
  const wrapped = new DrizzleQueryError(
    'insert into "payment_requests" ("id", "tx") values ($1, $2)',
    ["req-1", "PAYMENT-RACE-001"],
    postgresUniqueViolation("payment_requests_tx_normalized_uidx"),
  );
  assert.equal(String(wrapped).includes("unique"), false, "the wrapper must not be self-describing");
  assert.equal(isDuplicateKeyError(wrapped), true);
});

test("a bare SQLSTATE 23505 is recognised even without a matching message", () => {
  const error = new Error("insert failed") as Error & { code?: string };
  error.code = "23505";
  assert.equal(isDuplicateKeyError(error), true);
});

test("nested wrappers are traversed instead of only the outermost error", () => {
  const deep = new DrizzleQueryError("insert", [], new DrizzleQueryError("insert", [], postgresUniqueViolation("coupons_code_uidx")));
  assert.equal(isDuplicateKeyError(deep), true);
});

test("non-duplicate database failures are never classified as duplicates", () => {
  const foreignKey = new Error('insert or update on table "app_users" violates foreign key constraint') as Error & { code?: string };
  foreignKey.code = "23503";
  assert.equal(isDuplicateKeyError(new DrizzleQueryError("insert", [], foreignKey)), false);
  assert.equal(isDuplicateKeyError(new DrizzleQueryError("insert", [], new Error("connection terminated unexpectedly"))), false);
  assert.equal(isDuplicateKeyError(new DrizzleQueryError("insert", [], undefined)), false);
});

test("non-Error values and self-referencing cause chains fail closed", () => {
  assert.equal(isDuplicateKeyError(null), false);
  assert.equal(isDuplicateKeyError(undefined), false);
  assert.equal(isDuplicateKeyError("unique constraint"), false);
  const cyclic = new Error("boom") as Error & { cause?: unknown };
  cyclic.cause = cyclic;
  assert.equal(isDuplicateKeyError(cyclic), false);
});

test("the SQLSTATE of a wrapped query failure is reported without its message", () => {
  /* 42703 = undefined_column: the class of failure production hit when
   * app_users lagged the deployed schema. Only the code is surfaced. */
  const driver = new Error('column "email_verified_at" does not exist') as Error & { code?: string };
  driver.code = "42703";
  const wrapped = new DrizzleQueryError('select "email_verified_at" from "app_users"', [], driver);
  assert.equal(sqlStateOf(wrapped), "42703");
  assert.equal(sqlStateOf(driver), "42703");
  assert.equal(sqlStateOf(new Error("no code here")), null);
  assert.equal(sqlStateOf(null), null);
});
