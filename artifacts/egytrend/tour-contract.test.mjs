/**
 * Contract test for the guided tours rendered by the SPA shells.
 *
 * The tour engine lives in the inline script of index.html / admin.html, so a
 * broken step (a missing anchor, a deleted navigation function, or a control
 * that vanished) is exactly the kind of regression a build cannot catch. This
 * test pins the contract the product promises: real element targets, working
 * navigation, RTL + responsive chrome, server-persisted state, and replay
 * entry points from account settings.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shells = ["index.html", "admin.html"].map((name) => ({
  name,
  html: readFileSync(join(here, name), "utf8"),
}));

/* Anchors that only exist after the VIP page renders itself; the tour
 * navigates there before highlighting, so the shell owning the template that
 * creates them is what we assert. */
const DYNAMIC_VIP_ANCHORS = new Set(["vtabs-bar", "vip-body"]);

test("both shells keep the navigation the guided tour drives", () => {
  for (const { name, html } of shells) {
    assert.match(html, /function goNav\(id,options=\{\}\)\{/, `${name} must define goNav`);
    assert.match(html, /window\.addEventListener\("popstate"/, `${name} must handle back/forward`);
    /* The tour's checklist and steps call into these sections; a missing
     * definition would throw at click time, not build time. */
    for (const fn of ["toggleNotifPanel", "closeNotifPanel", "openNotifSettings", "loadOpps", "setOppFilter", "openOppDetail", "getNotifsStore"]) {
      assert.ok(new RegExp(`function ${fn}\\(`).test(html), `${name} must define ${fn}`);
    }
  }
});

test("every tour step targets an element the page actually renders", () => {
  for (const { name, html } of shells) {
    const targets = [...html.matchAll(/target:"(#[A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
    assert.ok(targets.length >= 8, `${name} declares platform + VIP tour steps (found ${targets.length})`);
    for (const selector of targets) {
      const id = selector.slice(1);
      if (DYNAMIC_VIP_ANCHORS.has(id)) {
        assert.ok(html.includes(`id="${id}"`), `${name} renders the VIP anchor ${selector}`);
        continue;
      }
      assert.ok(html.includes(`id="${id}"`), `${name} is missing the tour anchor ${selector}`);
    }
  }
});

test("both tours ship the required RTL controls and responsive chrome", () => {
  for (const { name, html } of shells) {
    assert.match(html, /<html[^>]*dir="rtl"/, `${name} is an RTL document`);
    for (const label of ["تخطي الجولة", "السابق", "التالي", "إنهاء"]) {
      assert.ok(html.includes(label), `${name} offers the "${label}" control`);
    }
    assert.ok(html.includes("tourFinish('skipped')"), `${name} persists a skip`);
    assert.ok(html.includes('tourFinish("completed")') || html.includes("tourNext()"), `${name} can finish`);
    assert.match(html, /function platformTourSteps\(\)/, `${name} defines the platform tour`);
    assert.match(html, /function vipTourSteps\(\)/, `${name} defines the VIP tour`);
    assert.match(html, /\.ob-panel-vip\{/, `${name} styles the VIP tour panel`);
    assert.match(html, /@media \(min-width:700px\)\{\.ob-checklist/, `${name} adapts the tour card for desktop`);
    assert.match(html, /@media \(prefers-reduced-motion:reduce\)/, `${name} respects reduced motion`);
  }
});

test("the platform tour explains the sections the product actually has", () => {
  for (const { name, html } of shells) {
    const body = html.slice(html.indexOf("function platformTourSteps()"), html.indexOf("function vipTourSteps()"));
    assert.ok(body.length > 400, `${name} has a platform tour body`);
    for (const id of ["home", "news", "markets", "opps", "ai", "benefits", "help"]) {
      assert.ok(body.includes(`id:"${id}"`), `${name} platform tour covers "${id}"`);
    }
  }
});

test("the VIP tour only offers features the server says are available", () => {
  for (const { name, html } of shells) {
    const body = html.slice(html.indexOf("function vipTourSteps()"), html.indexOf("function tourRemove()"));
    assert.ok(body.length > 400, `${name} has a VIP tour body`);
    /* Every optional feature step must be gated by the server-provided
     * vipFeatures projection — never by a browser-only guess. */
    for (const feature of ["calculators", "portfolio", "indicators", "ai", "opportunities", "priceAlerts"]) {
      assert.ok(body.includes(`on("${feature}")`), `${name} gates the ${feature} step on server state`);
    }
    for (const id of ["welcome", "markets", "manage"]) {
      assert.ok(body.includes(`id:"${id}"`), `${name} VIP tour always covers "${id}"`);
    }
    assert.ok(!/vipTourSteps[\s\S]{0,4000}localStorage/.test(body), `${name} VIP tour reads no browser storage for entitlements`);
  }
});

test("tour state is server-persisted so it survives a page refresh", () => {
  for (const { name, html } of shells) {
    const block = html.slice(html.indexOf("GUIDED TOURS"), html.indexOf("function firstUseChecklistAction"));
    assert.ok(block.length > 1000, `${name} contains the tour engine`);
    assert.ok(block.includes('"/api/user/onboarding"'), `${name} reads state from the API`);
    assert.ok(block.includes('"/api/user/onboarding/tour"'), `${name} writes tour actions to the API`);
    assert.ok(!/localStorage\.(setItem|getItem)|sessionStorage|DB\.s\(/.test(block), `${name} never stores tour state in the browser`);
    assert.ok(block.includes("credentials:\"same-origin\""), `${name} sends the session cookie with tour calls`);
  }
});

test("a failed tour load never blocks the product", () => {
  for (const { name, html } of shells) {
    const block = html.slice(html.indexOf("async function loadFirstUseOnboarding"), html.indexOf("function tourStart("));
    assert.ok(block.includes("catch{firstUseChecklistUnavailable();return null;}"), `${name} fails soft with a retry link`);
    assert.ok(html.includes("إعادة المحاولة"), `${name} offers the retry affordance`);
  }
});

test("both tours are replayable from account settings, and VIP only while VIP", () => {
  for (const { name, html } of shells) {
    assert.ok(/onclick="firstUseResetTour\(\)"/.test(html), `${name} has the platform tour replay button`);
    assert.ok(/onclick="vipTourReplay\(\)"/.test(html), `${name} has the VIP tour replay button`);
    /* The VIP replay button is only rendered for an active VIP entitlement,
     * and vipTourReplay() itself refuses non-VIP accounts. */
    const gate = html.slice(html.indexOf("async function vipTourReplay"), html.indexOf("async function firstUseResetTour"));
    assert.ok(gate.includes("firstUseVip().active!==true"), `${name} refuses the VIP tour without an active VIP`);
    assert.ok(html.includes("firstUseVip().active===true)btns+="), `${name} shows the VIP replay button only for VIP`);
  }
});
