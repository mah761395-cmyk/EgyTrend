/**
 * Contract test for the guest landing's price-board honesty (TASK H).
 *
 * The panel used to show a permanent «الأسعار غير متاحة الآن» because
 * rowById() looked for x.id while live market rows carry instrumentId.
 * This test pins the client half of the fix end to end:
 *  - rows are resolved by instrumentId (root cause regression),
 *  - the four states (loading / failed+retry / closed / no-data) are honest,
 *  - «بيانات حية» is only claimed for rows the source marks live,
 *  - the «آخر تحديث» card is tied to the newest REAL price's asOf (never
 *    the fetch/build time) and hidden without a verified price,
 *  - the 24h news stat prefers the server's full-feed count24h,
 *  - retry is bounded and the guest refresh cadence is bounded,
 *  - mobile (360px): the board sits under the title + CTA, single column,
 *    no fixed widths or nowrap clipping.
 * The server half (count24h computed before the presentation cap) is pinned
 * against api-server/src/routes/news.ts in the same file.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");
const newsTs = readFileSync(join(here, "..", "api-server", "src", "routes", "news.ts"), "utf8");

function functionBody(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `index.html must define ${name}`);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test("guest board rows are resolved by instrumentId (root cause)", () => {
  const byId = functionBody("rowById");
  assert.match(byId, /x\.instrumentId===id/, "rowById must match the instrumentId field");
  assert.ok(!/x\.id===id/.test(byId), "rowById must not match a bare .id field");
  assert.match(byId, /\["eg","gl","cm","cr","fx"\]/, "rowById scans the fx section too (EGP pairs live there since M1)");
  const card = functionBody("cardHtml");
  assert.match(card, /r\.v/, "the card value is the row's own value");
  assert.match(card, /\["egx:EGX30","fx:USD-EGP","commodity:XAU","crypto:BTC"\]\.includes\(r\.instrumentId\)/, "sparklines are keyed by instrumentId for the four hero assets");
  const missing = functionBody("missingCardHtml");
  assert.match(missing, /—/, "an unpriced row shows —, never an invented number");
  assert.ok(!/\d{2,}/.test(missing), "no numeric literal in the missing card");
});

test("the guest board has four honest states, never a silent skeleton", () => {
  const hero = functionBody("renderHero");
  // Loading: skeleton + explicit in-progress chip.
  assert.match(hero, /جارِ جلب الأسعار الحية…/, "loading state names what is happening");
  assert.match(hero, /SKELETON_CARDS/, "loading state keeps the skeleton");
  // Failed: explicit message + a working retry, and the retry is disabled
  // while a fetch is already in flight.
  assert.match(hero, /تعذر جلب الأسعار الآن — لن نعرض أرقامًا بديلة/, "failed state refuses to show substitute numbers");
  assert.match(hero, /onclick="lndRetry\(\)"/, "failed state offers a manual retry");
  assert.match(hero, /mf&&mf\.loading===true\?" disabled"/, "retry is disabled while a fetch is in flight");
  // A 20s ceiling: the skeleton cannot spin forever and become a lie.
  assert.match(hero, /timedOut=Date\.now\(\)-heroStart>20_000/, "a 20s first-load ceiling turns loading into the failed state");
  // Partial availability is disclosed, not hidden.
  assert.match(hero, /بعض الأسعار غير متاحة حاليًا/, "a partially priced board says so");
});

test("«بيانات حية» is only claimed for rows the source marks live", () => {
  const hero = functionBody("renderHero");
  assert.match(hero, /anyLive=reals\.some\(d=>rowIsLive\(d\[0\]\)\)/, "live claim comes from rowIsLive, per row");
  assert.match(hero, new RegExp('anyLive\\?"<i></i>بيانات حية":"آخر أسعار موثقة"'), "anything not live is labeled آخر أسعار موثقة instead");
  assert.match(hero, /قد تكون الأرقام متأخرة/, "stale rows carry an explicit lateness badge");
});

test("the «آخر تحديث» card is the newest REAL price's asOf, never the fetch time", () => {
  const stats = functionBody("loadStats");
  // asOf = max over the real hero rows only.
  assert.match(stats, /const heroAsOf=\(\)=>\{/, "the card's clock is derived from the hero rows");
  const heroAsOfBody = stats.slice(stats.indexOf("const heroAsOf="), stats.indexOf("};", stats.indexOf("const heroAsOf=")) + 2);
  assert.match(heroAsOfBody, /rows\.map\(r=>Number\(r\.asOf\)\|\|0\)/, "only rows with a verified asOf participate");
  assert.match(heroAsOfBody, /\.filter\(isReal\)/, "unpriced rows never contribute a timestamp");
  // The update card is written only when heroAsOf() > 0 — and nowhere else
  // in loadStats is a clock value written into it.
  const updateWrites = [...stats.matchAll(/set\("lnd-stat-update",(.*?)\);/g)].map(m => m[1]);
  assert.deepEqual(updateWrites, ["fmtCairoFull(t)"], "the update card is written exactly once, from the asOf value");
  assert.ok(!/Date\.now\(\)\)/.test(stats.slice(0, stats.indexOf('set("lnd-stat-update"'))), "no fetch/build time is written into the update card");
  // The date appears only when the asOf is not today (fmtCairoFull contract).
  const fmt = functionBody("fmtCairoFull");
  assert.match(fmt, /timeZone:"Africa\/Cairo"/, "the card uses Cairo time");
  assert.match(fmt, /dayKey\(new Date\(ms\)\)===dayKey\(new Date\(\)\)\)return time/, "today: time only");
  assert.match(fmt, /month:"long"/, "not today: the Arabic date is included");
});

test("the 24h news stat prefers the server's full-feed count", () => {
  const stats = functionBody("loadStats");
  assert.match(stats, /Number\.isFinite\(d\?\.count24h\)&&Number\(d\.count24h\)>=0/, "the server's count24h wins when present");
  assert.match(stats, /d\.items\.filter\(a=>\{const t=Date\.parse\(a\?\.pubDate\);return Number\.isFinite\(t\)&&t>0&&\(now-t\)<day;\}\)\.length/, "the client fallback counts in-window items only");
  assert.match(stats, /const now=Date\.now\(\),day=86400000/, "the fallback window is exactly 24h");
});

test("retry is rate-limited and the guest refresh cadence is bounded", () => {
  // lndRetry: 10s cooldown between manual retries.
  const retry = html.slice(html.indexOf("window.lndRetry="), html.indexOf("};", html.indexOf("window.lndRetry=")) + 2);
  assert.match(retry, /<10_000\)/, "manual retries are at least 10s apart");
  assert.match(retry, /fetchMarketsData\(true\)/, "a manual retry re-fetches the board");
  // Guest cadence: the board refreshes on a bounded interval while the
  // landing is on screen, and stops entirely when it is not.
  const start = functionBody("start");
  assert.match(start, /const guestIv=setInterval\(\(\)=>\{/, "the guest gets a periodic board refresh");
  assert.match(start, /if\(landingEl\(\)\?\.hidden\|\|U\)\{clearInterval\(guestIv\);return;\}/, "the guest interval stops when the landing leaves the screen");
  assert.match(start, /\},15000\);/, "the guest cadence is a fixed 15s state re-evaluation");
  assert.match(start, />=60_000/, "board data itself refreshes on a 60s cycle (the server caches 60s)");
  assert.match(start, /autoFails<5/, "automatic recovery is capped at 5 retries");
  assert.match(start, />=30_000&&autoFails<5/, "…30s apart, and leaves the manual button beyond that");
  // The stats polling after an empty tick is bounded too.
  const stats = functionBody("loadStats");
  assert.match(stats, /\+\+tries>20/, "the empty-tick poll gives up after 20 tries");
  assert.match(stats, /setTimeout\(\(\)=>clearInterval\(iv\),25000\)/, "and the poll cannot outlive 25s regardless");
});

test("mobile (360px): board under title + CTA, single column, no clipping", () => {
  // Document order inside .lnd-hero: the copy (title, lede, CTA) comes
  // before the price panel, so on a single-column layout the board renders
  // below the title and the CTA.
  const heroStart = html.indexOf('<section class="lnd-hero"');
  const copy = html.indexOf('class="lnd-hero-copy"', heroStart);
  const visual = html.indexOf('class="lnd-visual"', heroStart);
  assert.ok(heroStart !== -1 && copy !== -1 && visual !== -1, "hero, copy and panel all exist");
  assert.ok(copy < visual, "the price panel is in document order after the title/CTA block");
  const cta = html.indexOf('class="lnd-primary"', copy);
  assert.ok(cta !== -1 && cta < visual, "the primary CTA precedes the price panel");
  // Base layout is single column; two columns only from 680px up.
  const heroRule = html.match(/\.lnd-hero\{display:grid;grid-template-columns:1fr;[^}]*\}/);
  assert.ok(heroRule, "the base (mobile) hero is a single column");
  const twoCol = ".lnd-hero{padding:64px 0 34px;gap:54px;grid-template-columns:minmax(0,1.05fr) minmax(360px,.95fr);}";
  assert.ok(html.includes(twoCol), "the two-column hero rule exists");
  assert.ok(html.indexOf("@media (min-width:680px){") < html.indexOf(twoCol), "…and it lives inside the >=680px media query, not the base layout");
  // Stat values (including the long «٢٧ أكتوبر، ٠٥:٠٦ م» string) must be
  // allowed to wrap, never clipped or forced onto one line.
  const statB = html.match(/\.lnd-stat b\{[^}]*\}/);
  assert.ok(statB, "stat value style exists");
  assert.ok(!statB[0].includes("nowrap") && !statB[0].includes("overflow"), "stat values wrap freely at 360px");
  // No POSITIVE fixed min-widths in the board that could push 360px over
  // (min-width:0 is the overflow guard and is required).
  const boardCss = html.slice(html.indexOf(".lnd-mock-status"), html.indexOf(".lnd-stats{display:grid"));
  assert.ok(!/min-width:\s*[1-9]/.test(boardCss), "the price board uses no positive fixed min-width");
});

test("background: decorative animated light beams, motion-safe, no canvas", () => {
  const bg = html.match(/<div class="lnd-bg" aria-hidden="true">[\s\S]*?<\/svg>\s*((?:<i class="lnd-spark[^>]*><\/i>\s*){5})<\/div>/);
  assert.ok(bg, "the hero carries an aria-hidden background layer");
  assert.ok(bg[0].includes('class="lnd-bg-ray r1"') && bg[0].includes("lnd-bg-lines"), "elliptical rays plus thin SVG lines");
  assert.doesNotMatch(bg[0], /<canvas/i, "no canvas");
  const css = html.slice(html.indexOf(".lnd-bg{"), html.indexOf(".lnd-badge{"));
  assert.match(css, /\.lnd-bg\{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none;\}/, "absolute, behind content, click-through");
  // Each keyframe animates transform only (no top/left/width/height tweens).
  const rays = css.match(/@keyframes lndRay[ABC]\{[^@]*?\}\}/g) || [];
  assert.ok(rays.length >= 3, "three ray keyframes exist");
  for (const kf of rays) {
    assert.match(kf, /transform:/, "the ray moves via transform");
    assert.doesNotMatch(kf, /top:|left:|right:|bottom:|width:|height:/, "…and nothing else");
  }
  // Slow, ambient drift: 18-28s per ray.
  assert.match(css, /lndRayA 24s/, "ray A ~24s");
  assert.match(css, /lndRayB 28s/, "ray B ~28s");
  assert.match(css, /lndRayC 18s/, "ray C ~18s");
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.lnd-bg-ray\{animation:none\}/, "reduced motion stops the beams");
});

test("header badge: market state from the live state, never fixed text", () => {
  const badge = functionBody("renderLndMktBadge");
  assert.match(badge, /marketFreshness/, "state comes from the board's freshness");
  assert.match(badge, /rows\.some\(rowIsLive\)/, "«مباشر» only when the source marks a row live");
  assert.match(badge, /تحديث مباشر/, "live label");
  assert.match(badge, /إغلاق السوق/, "closed label");
  assert.match(badge, /غير متاح/, "unavailable label");
  assert.match(badge, /جارِ التحميل/, "loading label");
  assert.match(badge, /b\.innerHTML=/, "the label is (re)written on every render");
  assert.match(html, /id="lnd-mkt-badge" role="status"/, "badge is an announced status");
  const hero = functionBody("renderHero");
  assert.match(hero, /renderLndMktBadge\(\);/, "renderHero keeps the badge in sync");
});

test("hero: new title with Amiri accent, 76px on desktop, four real assets in the board", () => {
  assert.match(html, /<h1 id="landing-title">أسواقك كلها في مكان واحد،<br class="lnd-h1-br"> <em>وبالعربي\.<\/em><\/h1>/, "the design headline");
  assert.match(html, /family=Amiri:wght@400;700&family=Cairo/, "Amiri is loaded (display=swap on the link)");
  assert.match(html, /display=swap/, "font swap");
  const emCss = html.match(/\.lnd-hero-copy h1 em\{[^}]*\}/)[0];
  assert.match(emCss, /font-family:"Amiri",serif/, "accent word in Amiri");
  assert.match(emCss, /color:var\(--gl\)/, "accent colour per design (tokenised)");
  const h1 = html.match(/\.lnd-hero-copy h1\{[^}]*\}/)[0];
  assert.match(h1, /clamp\(34px,7\.2vw,76px\)/, "76px cap on desktop, fluid on mobile");
  const hero = functionBody("renderHero");
  assert.match(hero, /rowById\("commodity:XAU"\)/, "gold is a hero asset");
  assert.match(hero, /rowById\("crypto:BTC"\)/, "BTC is a hero asset");
  assert.match(hero, /rowById\("egx:EGX30"\)/, "EGX30 is a hero asset");
  assert.match(hero, /rowById\("fx:USD-EGP"\)/, "USD/EGP is a hero asset");
  assert.match(html, /class="lnd-board"/, "the board panel exists");
  const boardCss = html.match(/\.lnd-board\{[^}]*\}/)[0];
  assert.match(boardCss, /background:var\(--glass\)/, "glass background per design (tokenised)");
  assert.match(boardCss, /backdrop-filter:blur\(16px\)/, "16px blur per design");
  assert.match(boardCss, /border-radius:var\(--r24\)/, "24px radius per design (tokenised)");
  const navCss = html.match(/\.lnd-nav\{[^}]*\}/)[0];
  assert.match(navCss, /background:var\(--glass\);backdrop-filter:blur\(16px\)/, "glass header per design (tokenised)");
});

test("server half: count24h is counted before the presentation cap", () => {
  assert.match(newsTs, /export function countNewsInWindow\(/, "the pure window-count helper exists");
  assert.match(newsTs, /const count24h = countNewsInWindow\(feeds, Date\.now\(\)\);/, "the snapshot carries count24h");
  // Order matters: counted on the raw feeds, BEFORE dedupe-and-rank and the
  // 12-per-feed presentation cap.
  const countIdx = newsTs.indexOf("const count24h = countNewsInWindow(");
  const rankIdx = newsTs.indexOf("const rankedFeeds = dedupeAndRankFeeds(feeds);");
  assert.ok(countIdx !== -1 && rankIdx !== -1, "both the count and the ranking are present");
  assert.ok(countIdx < rankIdx, "count24h is computed before the feeds are ranked/capped");
  assert.match(newsTs, /__newsTest = \{[^}]*countNewsInWindow/s, "the helper is exported for tests");
});

test("the guest board fetches only the public endpoints", () => {
  const stats = functionBody("loadStats");
  const urls = [...stats.matchAll(/fetchJsonWithTimeout\("([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(urls, ["/api/markets/stocks", "/api/news/sources", "/api/news"], "stats read exactly the three public endpoints");
  const retry = html.slice(html.indexOf("window.lndRetry="), html.indexOf("};", html.indexOf("window.lndRetry=")) + 2);
  assert.ok(!/fetchJsonWithTimeout/.test(retry), "the manual retry reuses the shared board fetch, not a new endpoint");
});

test("document order: hero → stats → 4 cards → principles → gold VIP → plans → green trial → calculator → how → faq → footer", () => {
  const order = [
    '<section class="lnd-hero"',
    '<section class="lnd-stats" id="lnd-stats"',
    '<section id="features"',
    '<section id="principles"',
    '<section id="vip"',
    '<section id="pricing"',
    '<section class="lnd-trial"',
    '<section id="calculator"',
    '<section id="landing-how"',
    '<section id="faq"',
    '<footer class="lnd-footer">',
  ];
  const pos = order.map((s) => {
    const i = html.indexOf(s);
    assert.ok(i !== -1, `missing ${s}`);
    return i;
  });
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, "sections appear in the design order");
  assert.ok(!html.includes('class="lnd-cta-final"'), "the old final CTA banner is gone (replaced by the green trial card)");
});

test("background details: visible curves, dot grid, sparkles, stronger right glow", () => {
  const bg = html.match(/<div class="lnd-bg" aria-hidden="true">[\s\S]*?<\/svg>\s*((?:<i class="lnd-spark[^>]*><\/i>\s*){5})<\/div>/);
  assert.ok(bg, "background layer: rays + dot grid + curves + five sparkles");
  assert.ok(bg[0].includes('class="lnd-bg-dots"'), "dot-grid texture present");
  assert.doesNotMatch(bg[0], /<canvas/i, "still no canvas");
  const css = html.slice(html.indexOf(".lnd-bg{"), html.indexOf(".lnd-badge{"));
  assert.match(css, /rgba\(16,185,129,\.22\)/, "the right-side green glow was strengthened");
  assert.match(bg[0], /stroke="rgba\(52,211,153,\.15\)"/, "the green curve is visibly brighter");
  assert.match(css, /\.lnd-bg-dots\{[^}]*radial-gradient\(rgba\(148,163,184,\.13\) 1px[^}]*mask-image:linear-gradient/, "dots are subtle and masked to the top");
  assert.match(css, /\.lnd-spark-plus::before\{left:4px;top:0/, "plus marks are built from the sparkle element");
  const rays = css.match(/@keyframes lndRay[ABC]\{[^@]*?\}\}/g) || [];
  assert.ok(rays.length >= 3, "three ray keyframes still exist");
  for (const kf of rays) {
    assert.match(kf, /transform:/, "rays still move via transform only");
    assert.doesNotMatch(kf, /top:|left:|right:|bottom:|width:|height:/, "…and nothing else");
  }
});

test("four tool cards: real market rows, real headlines, locked VIP, computed example", () => {
  for (const id of ["feat-mkt-visual", "feat-news-list", "feat-calc-visual"])
    assert.ok(html.includes(`id="${id}"`), `card ${id} exists`);
  assert.match(html, /id="feat-mkt-live" role="status"/, "the markets card announces its data state");
  assert.match(html, /id="lnd-features-title">كل ما يحتاجه المستثمر <span class="lnd-hl">في شاشة واحدة\.<\/span>/, "the design headline of the cards section");
  assert.match(html, /<a href="#pricing">شوف الباقات<\/a>/, "the opportunities card links to the real plans section");
  const feat = functionBody("renderFeatCards");
  assert.match(feat, /rowById\("egx:EGX30"\)/, "markets card reuses the hero rows");
  assert.match(feat, /rowById\("fx:USD-EGP"\)/, "…including the EGP pair");
  assert.match(feat, /\.filter\(d=>isReal\(d\[0\]\)\)/, "unpriced rows are never shown in the card");
  assert.match(feat, /الأسعار غير متاحة الآن — لن نعرض أرقامًا بديلة\./, "honest unavailable state in the card");
  assert.match(feat, /window\.__lndNewsTop/, "headlines come from the shared /api/news response");
  assert.match(feat, /calcCompute\(\{amt:10000,price:25,pct:6\}\)/, "the example is computed with the public formula");
  assert.match(html, /مثال محسوب/, "the example is labeled as computed, not a recommendation");
  const stats = functionBody("loadStats");
  assert.match(stats, /window\.__lndNewsTop=d\.items\.slice\(0,3\)/, "top-3 headlines are captured from the same /api/news response (no extra request)");
  assert.ok(!/fetch|fetchJsonWithTimeout/.test(feat), "renderFeatCards renders only what the board/stats already loaded");
});

test("three principles pin the honesty contract", () => {
  const sec = html.slice(html.indexOf('<section id="principles"'), html.indexOf('<section id="vip"'));
  for (const [num, title] of [["01", "بيانات حقيقية"], ["02", "مصدر ووقت"], ["03", "وضوح كامل"]])
    assert.ok(sec.includes(`>${num}<`) && sec.includes(title), `principle ${num} «${title}»`);
});

test("gold VIP card: design gold, gated features, CTA to the real plans", () => {
  const sec = html.slice(html.indexOf('<section id="vip"'), html.indexOf('<section id="pricing"'));
  assert.match(sec, /lnd-vip-gold/, "the gold card exists");
  assert.match(sec, /id="lnd-vip-title">قرارات أدق\. أدوات أقوى\./, "the design headline");
  assert.match(sec, /تُفعَّل على حسابك وتُحسب على أسعار المصادر المرخّصة وتتحقق صلاحيتها من الخادم/, "honesty: features are computed on licensed prices and gated server-side");
  assert.match(sec, /href="#pricing">افتح VIP/, "the CTA anchors to the real plans section");
  assert.ok(sec.includes("تنبيهات سعرية") && sec.includes("محلل أخبار") && sec.includes("الحاسبات المتقدمة"), "the five VIP features are listed");
  const css = html.match(/\.lnd-vip-gold\{[^}]*\}/)[0];
  assert.match(css, /rgba\(227,183,91/, "gold accent per design (#E3B75B = rgba(227,183,91))");
});

test("plans: static 0-EGP free card + server plan cards; strikethrough only from admin oldPrice", () => {
  const sec = html.slice(html.indexOf('<section id="pricing"'), html.indexOf('<section class="lnd-trial"'));
  assert.match(sec, /class="lnd-plan lnd-plan-free"/, "the free card is static HTML");
  assert.match(sec, /<b>٠<\/b><span>ج\.م — للأبد<\/span>/, "…at 0 EGP forever");
  assert.ok(sec.includes('id="lnd-vip-plans"'), "server plans render into the section");
  assert.ok(sec.indexOf('id="lnd-vip-plans"') < sec.indexOf('class="lnd-plan lnd-plan-free"'), "per design: VIP plans sit on the right, the free card leftmost");
  assert.ok(sec.includes('id="lnd-pay-methods"') && sec.includes('id="lnd-policy"'), "payment methods + policy block kept");
  const price = functionBody("renderPricing");
  assert.match(price, /fetchSubscriptionConfig/, "plans come only from /api/payments/config");
  assert.ok(price.includes('p.oldPrice?`<s>${fmtInt(p.oldPrice)}</s>`:""'), "strikethrough only when the admin set an oldPrice");
  assert.ok(price.includes('p.badge?`<span class="lnd-plan-badge">'), "badges only from the admin config");
  assert.ok(price.includes('data-vip="${esc(key)}"'), "plan CTAs are wired");
  assert.match(price, /openAuthModal\("register"\)/, "…to the real registration flow");
  assert.match(price, /تعذر تحميل الباقات الآن — لن نعرض أسعارًا بديلة\./, "failure refuses substitute prices");
  assert.match(price, /lnd-pricing-retry/, "…with a manual retry");
});

test("green trial card: real email → real registration, no fake trial promise", () => {
  const sec = html.slice(html.indexOf('<section class="lnd-trial"'), html.indexOf('<section id="calculator"'));
  assert.match(sec, /لا بطاقة، لا خصم، ولا تجديد تلقائي/, "the trial terms match the real server flow");
  assert.match(sec, /7 أيام/, "…7 days as implemented server-side");
  assert.match(sec, /onsubmit="return lndStartTrial\(this\)"/, "the form is handled by lndStartTrial");
  const fn = functionBody("lndStartTrial");
  assert.match(fn, /openAuthModal\("register"\)/, "opens the real registration modal");
  assert.match(fn, /a-email/, "…and prefills the registration email");
  assert.match(fn, /window\.__lndTrialEmail/, "the email is passed to the flow");
  assert.ok(!/alert\(|confirm\(/.test(fn), "no blocking dialogs");
  const css = html.match(/\.lnd-trial\{[^}]*\}/)[0];
  assert.match(css, /var\(--gl\),#0E9F6E/, "green gradient per design (tokenised)");
  const trialCss = html.slice(html.indexOf(".lnd-trial-row input{"), html.indexOf("/* ─── Footer rebuild"));
  assert.match(trialCss, /\.lnd-trial-row input\{[^}]*min-height:50px/, "input is a 44px+ touch target");
  assert.match(trialCss, /\.lnd-trial-btn\{min-height:50px/, "the button is a 44px+ touch target");
});

test("footer: brand + real platform/resources/contact columns, disclaimer kept", () => {
  const fStart = html.indexOf('<footer class="lnd-footer">');
  const foot = html.slice(fStart, html.indexOf("</footer>", fStart));
  assert.ok(foot.includes('href="/privacy.html"') && foot.includes('href="/terms.html"'), "privacy + terms link to the real pages");
  assert.ok(foot.includes("wa.me/201008605139"), "the WhatsApp contact is kept");
  assert.match(foot, /وليست توصية استثمارية/, "the financial disclaimer is kept");
  for (const col of ["المنصة", "موارد", "تواصل"]) assert.ok(foot.includes(`<b>${col}</b>`), `column ${col}`);
  assert.ok(html.includes('id="lnd-mobbar"'), "the mobile quick bar is still present");
});

/* ────────────────────────────────────────────────────────────────
   STEP 1 — design tokens (single source of truth for ALL pages)
   ──────────────────────────────────────────────────────────────── */

const tokensCss = readFileSync(join(here, "tokens.css"), "utf8");
const uiCss = readFileSync(join(here, "ui.css"), "utf8");
const chartRuntime = readFileSync(join(here, "src", "chart-runtime.ts"), "utf8");
const adminHtml = readFileSync(join(here, "admin.html"), "utf8");

function styleBlocks(page) {
  return [...page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}

test("tokens: both files exist and are the single :root source loaded by BOTH entries", () => {
  const defined = new Set([...tokensCss.matchAll(/--[a-z0-9-]+(?=:)/g)].map((m) => m[0]));
  assert.ok(defined.size >= 60, `tokens.css defines the full palette (${defined.size} custom properties)`);
  for (const name of ["--ink", "--s1", "--b1", "--t1", "--t3", "--g", "--g2", "--gl", "--vip", "--up", "--dn", "--glass", "--hairline", "--r16", "--sh-1", "--t-fast", "--sans", "--mono"])
    assert.ok(defined.has(name), `tokens.css defines ${name}`);
  // exactly one :root, in tokens.css only
  assert.equal((tokensCss.match(/:root/g) || []).length, 1, "tokens.css owns the single :root");
  assert.equal((uiCss.match(/:root/g) || []).length, 0, "ui.css adds no :root of its own");
  // both pages load them via the shared JS bridge (Vite 7 drops shared linked CSS
  // across multiple HTML entries, so the imports live in the entry module)
  assert.match(chartRuntime, /import "\.\.\/tokens\.css"/, "chart-runtime imports tokens.css");
  assert.match(chartRuntime, /import "\.\.\/ui\.css"/, "chart-runtime imports ui.css");
  for (const [name, page] of [["index.html", html], ["admin.html", adminHtml]]) {
    assert.equal((page.match(/<link[^>]*tokens\.css/g) || []).length, 0, `${name}: no dangling <link> (would be dropped by Vite)`);
    assert.match(page, /<script type="module" src="\/src\/chart-runtime\.ts">/, `${name} loads the shared CSS bridge`);
  }
});

test("tokens: no page defines :root of its own anymore (no duplication)", () => {
  for (const [name, page] of [["index.html", html], ["admin.html", adminHtml]]) {
    assert.equal((styleBlocks(page).join("\n").match(/:root/g) || []).length, 0, `${name}: :root lives only in tokens.css`);
  }
});

test("tokens: every var() used is defined in tokens.css (no undefined custom properties)", () => {
  const defined = new Set([...tokensCss.matchAll(/--[a-z0-9-]+(?=:)/g)].map((m) => m[0]));
  const used = new Set();
  for (const page of [html, adminHtml, uiCss]) {
    const blocks = page === uiCss ? [uiCss] : styleBlocks(page);
    for (const m of blocks.join("\n").matchAll(/var\(\s*(--[a-z0-9-]+)/g)) used.add(m[1]);
  }
  const missing = [...used].filter((u) => !defined.has(u));
  assert.deepEqual(missing, [], `undefined custom properties: ${missing.join(", ")}`);
});

test("tokens: the var(--bg) bug is gone and unified colours use the app tokens", () => {
  for (const [name, page] of [["index.html", html], ["admin.html", adminHtml]]) {
    assert.ok(!/var\(--bg\)/.test(page), `${name}: no var(--bg) (undefined variable bug)`);
    // divergent colours now reference tokens, not raw hex
    const css = styleBlocks(page).join("\n").toUpperCase();
    for (const gone of ["#EAF0FF", "#F5C451", "#24305E", "#04121F", "#B9C4E6", "#C9D4F2", "#C7D2E4", "#8FA0C9", "#2F3F7A"])
      assert.ok(!css.includes(gone), `${name}: ${gone} unified into tokens.css`);
  }
});

test("tokens: green accent, glass and reduced-motion live in the single token file", () => {
  assert.match(tokensCss, /--gl:#34D399/, "#34D399 registered as --gl");
  assert.match(tokensCss, /--glass:rgba\(14,21,36,\.62\)/, "landing glass value tokenised");
  assert.match(tokensCss, /--glass-hdr:rgba\(3,7,18,\.96\)/, "header glass tokenised");
  assert.match(tokensCss, /--hairline:rgba\(255,255,255,\.08\)/, "hairline tokenised");
  assert.match(tokensCss, /@media \(prefers-reduced-motion:\s*reduce\)/, "global reduced-motion rule");
  assert.match(tokensCss, /animation-iteration-count:1 !important/, "animations stop (not hide) under reduced motion");
});
