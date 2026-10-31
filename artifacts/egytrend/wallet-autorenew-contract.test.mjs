/**
 * Contract test: manual payment without a transfer number + wallet
 * auto-renewal (client side).
 *
 * Rules enforced here:
 *  - "رقم عملية التحويل" is gone from BOTH payment modals (index.html and
 *    the duplicated admin.html modal): no input, no required validation,
 *    no reliance in the status card; legacy rows keep showing TX only when
 *    a stored value exists;
 *  - the proof image stays required in both flows;
 *  - explicit consent: the checkbox is labeled as explicit consent
 *    (موافقة صريحة), is optional, and is sent as `autoRenew`;
 *  - wallet UI renders ONLY server data (balance, limits, ledger,
 *    renewal state) — nothing computed client-side;
 *  - top-up is a manual proof-backed request (pending until admin
 *    approval) — there is no automatic top-up path anywhere in the UI;
 *  - the renewal toggle calls the dedicated endpoint and the disable
 *    copy states the current term keeps running.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "index.html"), "utf8");
const adminHtml = readFileSync(join(here, "admin.html"), "utf8");

function scriptOf(page) {
  const m = page.match(/<script>([\s\S]*?)<\/script>/g) || [];
  const bodies = m.map((s) => s.replace(/^<script>/, "").replace(/<\/script>$/, ""));
  bodies.sort((a, b) => b.length - a.length);
  return bodies[0] || "";
}
const indexJs = scriptOf(indexHtml);
const adminJs = scriptOf(adminHtml);

test("the transfer number field and its validation are gone from both payment modals", () => {
  for (const [name, page, js] of [["index.html", indexHtml, indexJs], ["admin.html", adminHtml, adminJs]]) {
    assert.ok(!page.includes('id="tx-in"'), `${name}: no tx input element remains`);
    assert.ok(!js.includes('أدخل رقم عملية التحويل'), `${name}: no required-tx validation remains`);
    /* The payment body must no longer ship `tx` from the form. */
    assert.ok(!/tx\s*:\s*tx\b/.test(js), `${name}: submitPay no longer reads the tx field`);
    /* Proof stays required. */
    assert.ok(/if\(!payProofData\)/.test(js), `${name}: proof image is still required`);
    assert.ok(/proofImage:payProofData/.test(js), `${name}: proof image is still submitted`);
    /* Instructions no longer ask for a transfer number. */
    assert.ok(!page.includes("أدخل رقم العملية وارفع الصورة"), `${name}: instructions no longer mention the transfer number`);
  }
});

test("the status card no longer displays the transfer number", () => {
  for (const [name, js] of [["index.html", indexJs], ["admin.html", adminJs]]) {
    assert.ok(!js.includes("pen.tx"), `${name}: pending status card does not render tx`);
  }
});

test("explicit consent: labeled, optional, and submitted as autoRenew", () => {
  for (const [name, page, js] of [["index.html", indexHtml, indexJs], ["admin.html", adminHtml, adminJs]]) {
    assert.ok(page.includes('id="autorenew-chk"'), `${name}: consent checkbox exists`);
    assert.ok(page.includes("موافقة صريحة"), `${name}: the label states EXPLICIT consent`);
    assert.ok(page.includes("التجديد التلقائي من المحفظة"), `${name}: the label names wallet auto-renewal`);
    /* It is a plain checkbox — never a mandatory gate. */
    assert.match(js, /const autoRenew=!!\(document\.getElementById\("autorenew-chk"\)/, `${name}: autoRenew is an opt-in boolean`);
    assert.match(js, /autoRenew,senderPhone/, `${name}: the payment body carries autoRenew`);
    /* No client-side entitlement: approval still happens on the server. */
    assert.ok(!/autoRenew.*?vip/.test(js), `${name}: consent does not grant VIP client-side`);
  }
});

test("the approved payment state is now visible on the VIP page", () => {
  const fn = indexJs.slice(indexJs.indexOf("async function loadPayStatus"), indexJs.indexOf("async function loadPayStatus") + 4000);
  assert.match(fn, /status==="approved"/, "loadPayStatus handles the approved status");
  assert.match(fn, /تم اعتماد الدفع/, "approved state shows a clear confirmation");
});

test("wallet card: server data only, manual proof-backed top-up, no automatic crediting", () => {
  assert.ok(indexHtml.includes('id="wallet-card"'), "wallet card container exists");
  assert.ok(indexJs.includes("async function loadWalletCard"), "loadWalletCard defined");
  assert.match(indexJs, /fetch\("\/api\/payments\/wallet"/, "balance state comes from the server");
  assert.match(indexJs, /fetch\("\/api\/payments\/wallet\/topup",\{method:"POST"/, "top-up is a POST request");
  assert.match(indexJs, /amount:walletTopupAmount,method:walletTopupMethodId,proofImage:walletTopupProof/, "top-up submits amount + method + proof");
  assert.match(indexJs, /if\(!walletTopupProof\)/, "top-up proof is required");
  assert.match(indexJs, /يُضاف الرصيد بعد اعتماد الإدارة/, "top-up stays pending until admin approval (no auto credit)");
  /* The balance is only ever rendered from the server payload. */
  assert.match(indexJs, /const bal=Number\(w\.balance\)\|\|0/, "balance rendered from server state");
  /* No automatic top-up from any external method anywhere in the UI. */
  assert.ok(!/topupAuto|autoTopup|شحن تلقائي/.test(indexJs + adminJs), "no automatic top-up path in the UI");
});

test("renewal toggle: dedicated endpoint, disable keeps the current term", () => {
  assert.match(indexJs, /fetch\("\/api\/payments\/wallet\/auto-renew",{method:"PUT"/, "toggle calls the PUT endpoint");
  assert.match(indexJs, /body:JSON\.stringify\(\{enabled\}\)/, "toggle submits {enabled}");
  assert.match(indexJs, /إيقافه لا يلغي المدة الحالية|المدة الحالية سارية حتى نهايتها/, "disable copy states the term keeps running");
  assert.match(indexJs, /قبل ٣ أيام/, "the 3-day-ahead notice is communicated");
});

test("admin review panel: wallet top-ups labeled, TX badge only for legacy rows", () => {
  assert.match(adminJs, /wallet_topup"\?"💰 شحن المحفظة"/, "wallet_topup requests show the top-up label");
  assert.match(adminJs, /\$\{req\.tx\?`<span class="bdg"[^]*?TX:\$\{sanitize\(req\.tx\)\}<\/span>`:""\}/, "TX badge renders only when a stored tx exists");
  /* Proof viewing and approve/reject are untouched. */
  assert.ok(adminJs.includes("viewProof"), "proof viewing preserved");
  assert.ok(adminJs.includes("admApp("), "approve action preserved");
  assert.ok(adminJs.includes("admRej("), "reject action preserved");
});
