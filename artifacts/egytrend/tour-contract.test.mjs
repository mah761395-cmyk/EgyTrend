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
    /* Every individually scoped feature step must be gated by the
     * server-provided vipFeatures projection — never by a browser-only guess. */
    for (const feature of ["calculators", "portfolio", "indicators", "ai", "opportunities", "priceAlerts"]) {
      assert.ok(body.includes(`on("${feature}")`), `${name} gates the ${feature} step on server state`);
    }
    /* The screener, markets/reports and subscription management ship inside
     * the VIP area (no separate server scope) and are always part of the
     * tour for an active entitlement. */
    for (const id of ["scr", "markets", "manage"]) {
      assert.ok(body.includes(`id:"${id}"`), `${name} VIP tour always covers "${id}"`);
    }
    assert.ok(body.includes(`target:"#scr-box"`), `${name} screener step targets the real screener box`);
    /* Honest scope (A1): the portfolio step claims only the EGX30 benchmark
     * comparison the page actually renders. */
    const portfolioStep = body.slice(body.indexOf('id:"portfolio"'), body.indexOf('id:"scr"'));
    assert.ok(portfolioStep.includes("EGX30"), `${name} portfolio step names the real EGX30 benchmark`);
    assert.ok(portfolioStep.includes("نقاط إغلاق مشتركة"), `${name} portfolio step states the comparison's real precondition`);
    assert.ok(!/vipTourSteps[\s\S]{0,4000}localStorage/.test(body), `${name} VIP tour reads no browser storage for entitlements`);
  }
});

test("the VIP tour ends on a \"ready!\" screen of real, gated tasks", () => {
  for (const { name, html } of shells) {
    const end = html.slice(html.indexOf("function tourRenderEnd()"), html.indexOf("function tourRender()"));
    assert.ok(end.length > 400, `${name} renders a dedicated VIP end screen`);
    assert.ok(end.includes("جاهز!"), `${name} end screen title is exact`);
    assert.ok(end.includes("ob-end-tasks"), `${name} end screen lists actionable tasks`);
    assert.ok(end.includes("tourFinish('completed')"), `${name} end screen offers a primary finish action`);
    assert.ok(end.includes("ابدأ المتابعة"), `${name} end screen primary button is "ابدأ المتابعة"`);
    assert.ok(end.includes("tourBack()"), `${name} end screen can go back to the last step`);
    assert.ok(!end.includes("من ${tour.steps.length}"), `${name} end screen is not counted in "N of M"`);
    /* Every optional task must be gated by the server projection; the
     * screener task is always available inside VIP. */
    for (const feature of ["portfolio", "priceAlerts", "calculators", "ai"]) {
      assert.ok(end.includes(`on("${feature}")`), `${name} gates the ${feature} end task on server state`);
    }
    assert.ok(html.includes("function tourEndGo("), `${name} tasks open the real feature via tourEndGo`);
    /* The finish-on-last-step path only takes the VIP kind to the end screen. */
    const next = html.slice(html.indexOf("function tourNext()"), html.indexOf("function tourBack()"));
    assert.ok(next.includes('tour.kind==="vip"'), `${name} only the VIP tour routes to the end screen`);
  }
});

test("the VIP tour opens with a dedicated gold welcome screen", () => {
  for (const { name, html } of shells) {
    const welcome = html.slice(html.indexOf("function tourRenderWelcome()"), html.indexOf("function tourRender()"));
    assert.ok(welcome.length > 300, `${name} renders a dedicated VIP welcome screen`);
    assert.ok(welcome.includes("أهلاً بيك في VIP"), `${name} welcome screen title is exact`);
    assert.ok(welcome.includes("خلّينا نعرّفك على أهم الأدوات اللي هتساعدك تتابع السوق وتستخدم مميزات حسابك."), `${name} welcome screen copy is exact`);
    assert.ok(welcome.includes("ابدأ الجولة"), `${name} welcome offers "ابدأ الجولة"`);
    assert.ok(welcome.includes("تخطّي"), `${name} welcome offers "تخطّي"`);
    assert.ok(welcome.includes("ob-panel-welcome"), `${name} welcome screen carries the gold panel class`);
    assert.ok(!welcome.includes("من ${tour.steps.length}"), `${name} welcome screen is not counted in "N of M"`);
    assert.ok(html.includes(".ob-panel-welcome{"), `${name} styles the gold welcome panel`);
    /* The welcome renders for the VIP kind only, and the back button on step
     * one returns to it. */
    const render = html.slice(html.indexOf("function tourRender()"), html.indexOf("async function firstUseRequest"));
    assert.ok(render.includes("if(vip&&tour.atWelcome){tourRenderWelcome();return;}"), `${name} VIP tour renders the welcome first`);
    const start = html.slice(html.indexOf("function tourStart(kind,steps)"), html.indexOf("function tourNext()"));
    assert.ok(start.includes("atWelcome:kind===\"vip\""), `${name} only the VIP tour starts on the welcome screen`);
  }
});

test("the VIP tour spotlights with a gold frame and waits for the real target", () => {
  for (const { name, html } of shells) {
    assert.ok(html.includes(".ob-tour-highlight-vip{"), `${name} defines the gold VIP highlight frame`);
    assert.ok(html.includes("vip&&\"ob-tour-highlight-vip\""), `${name} applies the gold frame to VIP steps only`);
    /* The step spotlight must wait for the target element with
     * requestAnimationFrame and never a blind setTimeout; a target that never
     * appears is skipped safely instead of trapping the user. */
    const spotlight = html.slice(html.indexOf("function tourSpotlight("), html.indexOf("function currentNavId()"));
    assert.ok(spotlight.length > 200, `${name} has an element-presence spotlight waiter`);
    assert.ok(spotlight.includes("requestAnimationFrame(tick)"), `${name} spotlight waits via requestAnimationFrame`);
    assert.ok(spotlight.includes("deadline"), `${name} spotlight has a bounded deadline`);
    assert.ok(spotlight.includes("tourFinish(\"completed\");else tourNext()"), `${name} a missing target is skipped safely`);
    assert.ok(!html.includes("setTimeout(()=>tourHighlight(step),30)"), `${name} keeps no blind 30ms highlight timer`);
  }
});

test("tour actions meet the 44px touch target and reduced-motion rules", () => {
  for (const { name, html } of shells) {
    const actions = html.match(/\.ob-panel-actions button\{[^}]*\}/)?.[0] || "";
    assert.ok(actions.includes("min-height:44px"), `${name} tour action buttons are >=44px tall`);
    const skip = html.match(/\.ob-skip\{[^}]*\}/)?.[0] || "";
    assert.ok(skip.includes("min-height:44px"), `${name} the skip control is a >=44px touch target`);
    assert.ok(html.includes("prefers-reduced-motion:reduce){.ob-tour-backdrop,.ob-panel,.ob-progress-value,.ob-tour-highlight"), `${name} disables tour motion under reduced-motion`);
  }
});

test("the VIP tour restores the tab the user was on before it opened", () => {
  for (const { name, html } of shells) {
    assert.ok(html.includes("function tourRestorePreNav()"), `${name} defines pre-tour navigation restore`);
    assert.ok(html.includes("tourPreNav={nav:currentNavId(),vipTab:typeof vipTab===\"string\"?vipTab:null}"), `${name} captures the pre-tour nav and VIP tab`);
    const finishStart = html.indexOf("async function tourFinish(action)");
    const finishEnd = html.indexOf("document.addEventListener(\"keydown\"", finishStart);
    const finish = html.slice(finishStart, finishEnd === -1 ? undefined : finishEnd);
    assert.ok(finish.includes("tourRestorePreNav()"), `${name} restoring happens when the tour finishes`);
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
    /* Replay must NOT clear the permanent server state: it starts the tour
     * directly (the started action is bookkept as a replay server-side) and
     * never calls the destructive reset endpoint. */
    assert.ok(!gate.includes("onboarding/reset"), `${name} VIP replay never resets the permanent completion`);
    assert.ok(gate.includes('tourStart("vip",vipTourSteps())'), `${name} VIP replay starts the tour directly`);
  }
});

test("the tour is keyboard-operable: arrows, ESC, focus trap, live announcements", () => {
  for (const { name, html } of shells) {
    const key = html.slice(html.indexOf('document.addEventListener("keydown"'), html.indexOf("async function firstUseStartTour"));
    assert.ok(key.length > 200, `${name} has a tour keydown handler`);
    assert.ok(key.includes('event.key==="Escape"'), `${name} ESC closes the tour`);
    assert.ok(key.includes('event.key==="ArrowLeft"'), `${name} ArrowLeft advances (RTL forward)`);
    assert.ok(key.includes('event.key==="ArrowRight"'), `${name} ArrowRight goes back (RTL back)`);
    assert.ok(key.includes("focusables"), `${name} implements a focus trap`);
    /* Every tour screen announces its state through a polite live region. */
    assert.ok(html.includes("ob-tour-sr"), `${name} defines the visually-hidden live region`);
    assert.ok(html.includes('role="status" aria-live="polite"'), `${name} tour screens carry a live region`);
    assert.ok(html.includes("الخطوة ${tour.index+1} من ${tour.steps.length}: ${step.title}"), `${name} announces each step to screen readers`);
    /* Focus is captured when the tour opens and restored when it finishes. */
    assert.ok(html.includes("let tourTriggerEl=null"), `${name} tracks the pre-tour focus target`);
    assert.ok(html.includes("tourTriggerEl=(document.activeElement"), `${name} captures focus at tour start`);
    const finishStart = html.indexOf("async function tourFinish(action)");
    const finishEnd = html.indexOf('document.addEventListener("keydown"', finishStart);
    const finish = html.slice(finishStart, finishEnd === -1 ? undefined : finishEnd);
    assert.ok(finish.includes("trigger.focus({preventScroll:true})"), `${name} restores focus when the tour finishes`);
    /* The panel focuses its primary action on render. */
    assert.ok(html.includes('root.querySelector(".ob-next")?.focus({preventScroll:true})'), `${name} focuses the primary action on render`);
  }
});
