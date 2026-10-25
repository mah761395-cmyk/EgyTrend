import assert from "node:assert/strict";
import test from "node:test";
import { getCalculatorMathModuleSource, investorProjection } from "./math";
import { getCalculatorRuntimeModuleSource } from "./runtime";

/* The VIP browser modules are produced at runtime from compiled function
 * bodies. These tests import that exact text as a data: ES module, so a type
 * annotation, a broken helper reference or a renamed export fails here instead
 * of in a subscriber's browser. */

async function importSource(source: string): Promise<Record<string, unknown>> {
  const url = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
  return (await import(url)) as Record<string, unknown>;
}

test("generated math module is valid ESM and reproduces the server investor result", async () => {
  const source = getCalculatorMathModuleSource();
  assert.match(source, /export \{ [^}]*investorProjection[^}]*\}/);
  assert.doesNotMatch(source, /CalculatorResult</, "compiled module must not carry TypeScript types");

  const module = await importSource(source);
  assert.equal(typeof module.investorProjection, "function");

  const input = { initialAmount: 100000, monthlyContribution: 5000, months: 60, annualReturnPercent: 18 };
  const server = investorProjection(input);
  const browser = (module.investorProjection as (value: unknown) => unknown)(input);
  assert.deepEqual(browser, JSON.parse(JSON.stringify(server)));

  /* Invalid input must fail the same way in the browser module. */
  const browserError = (module.investorProjection as (value: unknown) => { ok: boolean; error?: string })({ initialAmount: 0, monthlyContribution: 0, months: 12, annualReturnPercent: 10 });
  assert.equal(browserError.ok, false);
  assert.match(browserError.error || "", /رأس مال|مساهمة/);
});

test("generated runtime module is valid ESM and mounts the investor calculator", async () => {
  const source = getCalculatorRuntimeModuleSource();
  /* Compiled output may escape Arabic as \uXXXX sequences, so assert on the
     ASCII identifiers/markup that prove the investor view is wired in. */
  assert.match(source, /investorProjection/);
  assert.match(source, /calc-scenarios/);
  assert.match(source, /calc-assumptions/);
  assert.match(source, /data-tip/);
  /* The runtime must not fall back to a previously generated chart of stale data. */
  assert.doesNotMatch(source, /compoundChart/);

  const module = await importSource(source);
  assert.equal(typeof module.mountCalculatorRuntime, "function");
});
