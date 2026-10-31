/**
 * Contract test: the smart notification center is wired the way it was
 * designed —
 *   - the full feed is SERVER-OWNED: the client only ever reads/writes
 *     /api/notifications* (never a local identity for the private feed);
 *   - the profile page hosts the center card (unread count, list, per-type
 *     delivery toggles, watchlist mirror sync);
 *   - the bell shows the server unread count merged with the local ambient
 *     unread, and offers a one-tap jump to the center;
 *   - every local watchlist change silently mirrors the EGX-follows to the
 *     server (fire-and-forget) so scheduled news matching stays current;
 *   - logged-out visitors see a login hint, not an error.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");

test("the center card lives on the profile page", () => {
  assert.ok(html.includes('id="nc-card"'), "center card element");
  assert.ok(html.includes("مركز الإشعارات"), "Arabic center title");
  assert.ok(html.includes('id="nc-list"'), "feed list container");
  assert.ok(html.includes('id="nc-unread"'), "unread counter");
  assert.ok(html.includes('id="nc-pref-price"'), "price family toggle");
  assert.ok(html.includes('id="nc-pref-opps"'), "opportunities family toggle");
  assert.ok(html.includes('id="nc-pref-news"'), "news family toggle");
  assert.ok(html.includes('onclick="ncMarkAllRead()"'), "mark-all button");
  assert.ok(html.includes('onclick="ncSyncFollows()"'), "manual watchlist sync button");
  /* the card sits inside page-profile, before the support block */
  const profileStart = html.indexOf('id="page-profile"');
  const cardStart = html.indexOf('id="nc-card"');
  const supportStart = html.indexOf('id="help-tour-anchor"');
  assert.ok(profileStart !== -1 && cardStart !== -1 && supportStart !== -1);
  assert.ok(profileStart < cardStart && cardStart < supportStart, "card order inside the profile page");
});

test("the client talks to the server feed, not to a private local store", () => {
  assert.ok(html.includes('fetch("/api/notifications"'), "feed read");
  assert.ok(html.includes('"/api/notifications/follows"'), "follows endpoint");
  assert.ok(html.includes("ncFetch(\"/prefs\")"), "prefs read");
  assert.ok(html.includes("/read-all"), "mark-all endpoint");
  assert.ok(html.includes('encodeURIComponent(id)+"/read"'), "per-item read endpoint");
  assert.ok(html.includes('method:"DELETE"'), "delete is an explicit method, not a query flag");
  assert.ok(html.includes("credentials:\"same-origin\""), "session cookie is the only identity");
});

test("delivery prefs are per-family and persist server-side", () => {
  assert.ok(html.includes("ncTogglePref('price',this.checked)"));
  assert.ok(html.includes("ncTogglePref('opps',this.checked)"));
  assert.ok(html.includes("ncTogglePref('news',this.checked)"));
  const toggle = html.slice(html.indexOf("async function ncTogglePref("), html.indexOf("function ncEgxFollows("));
  assert.ok(toggle.includes('method:"PUT"'), "prefs are PUT (replace), not POST-append");
  assert.ok(toggle.includes("JSON.stringify({[kind]:on})"), "single-family payload");
});

test("watchlist changes mirror EGX-follows to the server", () => {
  const hooks = html.match(/DB\.s\("wl",wl\);ncFollowsAutoSync\(\);/g) || [];
  assert.ok(hooks.length >= 4, `all local watchlist saves sync (${hooks.length} found)`);
  const fn = html.slice(html.indexOf("function ncFollowsAutoSync("), html.indexOf("function openNotifCenter("));
  assert.ok(fn.includes("ncEgxFollows()"), "only EGX-catalog symbols are mirrored");
  assert.ok(fn.includes(".catch(()=>{})"), "fire-and-forget: a failed sync never blocks UI writes");
  const egx = html.slice(html.indexOf("function ncEgxFollows("), html.indexOf("async function ncSyncFollows("));
  assert.ok(egx.includes("liveStocks.some(x=>x.sym===s)"), "filtered against the real EGX catalog");
});

test("the bell merges server unread and opens the center in one tap", () => {
  const badge = html.slice(html.indexOf("function updateBellBadge()"), html.indexOf("function updateBellBadge()", html.indexOf("function updateBellBadge()") + 10) + 400);
  assert.ok(html.includes("store.unread+(U?ncServerUnread:0)"), "local + server unread, server only while signed in");
  const bellActs = html.slice(html.indexOf('class="notif-acts"'), html.indexOf("</div>", html.indexOf('class="notif-acts"')));
  assert.ok(bellActs.includes("onclick=\"openNotifCenter()\""), "one-tap center button in the bell panel");
  const opener = html.slice(html.indexOf("function openNotifCenter("), html.indexOf("function showPlatNotif("));
  assert.ok(opener.includes('goNav("profile")'), "jumps to the profile page");
  assert.ok(opener.includes("scrollIntoView"), "scrolls to the center card");
  assert.ok(opener.includes("ncLoad()"), "refreshes the feed on open");
});

test("a signed-in visitor gets periodic server refresh; logged-out gets a hint", () => {
  assert.ok(html.includes("startNcPolling();"), "polling started at boot");
  const poller = html.slice(html.indexOf("function startNcPolling("), html.indexOf("function ncApplyPrefs("));
  assert.ok(poller.includes("setInterval(ncPollTick,30000)"), "30s server poll");
  assert.ok(poller.includes("if(ncPollTimer||!U)return;"), "no polling without a session");
  const render = html.slice(html.indexOf("function ncRenderFeed("), html.indexOf("function ncLoad()"));
  assert.ok(render.includes("سجّل الدخول"), "logged-out hint");
  assert.ok(render.includes("ncServerUnread=0"), "server unread is cleared when signed out");
});
