import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalOpportunities } from "./opp-engine";

test("observation engine fails closed without a verified source or provider timestamp", () => {
  const cards = buildLocalOpportunities(null, [{
    sym: "NO_SOURCE", name: "شركة اختبار", sector: "بنوك", price: 10, chgPct: 3.2,
    // A numeric field alone must not make a card.
  }, {
    sym: "NO_TIME", name: "شركة اختبار", sector: "بنوك", price: 10, chgPct: 3.2,
    source: "Licensed EGX",
    // A server cannot silently substitute its fetch time for this value.
  }], [], "16 أكتوبر 2026");
  assert.deepEqual(cards, []);
});

test("observation engine emits descriptive source-backed cards without target returns or trading instructions", () => {
  const cards = buildLocalOpportunities({
    markets: {
      cm: [{ n: "ذهب", v: "$4,000", c: "+1.20%", source: "Licensed metals", asOf: 1_790_000_000_000 }],
      cr: [], gl: [],
    },
  }, [{
    sym: "TEST", name: "شركة اختبار", sector: "بنوك", price: 10, chgPct: 3.2,
    source: "Licensed EGX", ts: 1_790_000_000_000,
  }], ["عنوان لا يستخدمه المحرك كتوصية"], "16 أكتوبر 2026");

  assert.ok(cards.length >= 2);
  assert.ok(cards.every((card) => card.expectedReturn === undefined));
  assert.ok(cards.every((card) => card.featured === false));
  assert.ok(cards.every((card) => !/^\[AUTO\]/.test(card.sector)));
  const allText = cards.map((card) => `${card.title} ${card.summary} ${card.details}`).join(" ");
  assert.doesNotMatch(allText, /اشتر|بِع|بعْ|احتفظ|زد مركز|نقطة دخول|وقف خسارة/);
  assert.match(allText, /لا تمثل البطاقة توصية أو توقعًا/);
  assert.match(allText, /Licensed EGX/);
  assert.match(allText, /Licensed metals/);
});
