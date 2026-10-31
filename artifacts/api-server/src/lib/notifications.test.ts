import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDatabase } from "../test-support/memory-db";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { EGX_STOCKS } from "./market-data/catalog";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-only-session-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type TestDb = NodePgDatabase<typeof schema>;
let db: TestDb;
let closeDb: () => Promise<void>;
let N: typeof import("./notifications");
const phoneVip = "01110000001";
const phoneFree = "01110000002";
const phoneVipNoNews = "01110000003";
const nowMs = Date.now();

function seedUser(phone: string, name: string, plan: "free" | "vip", vipDays = 0) {
  const now = new Date(nowMs);
  return db.insert(schema.appUsersTable).values({
    phone, name, email: null, emailVerifiedAt: null,
    passwordHash: "x", plan,
    vipExpiresAt: vipDays ? new Date(nowMs + vipDays * 86_400_000) : null,
    status: "active", createdAt: now, updatedAt: now,
  });
}

before(async () => {
  const memory = await createMemoryDatabase();
  globalThis.__egytrendTestDatabase = memory.db;
  closeDb = memory.close;
  const mod = await import("@workspace/db");
  db = mod.db as TestDb;
  N = await import("./notifications");
  await seedUser(phoneVip, "فلاح VIP", "vip", 1);
  await seedUser(phoneFree, "مجاني", "free");
  await seedUser(phoneVipNoNews, "VIP بلا أخبار", "vip", 1);
  await N.setNotifPrefs(phoneVipNoNews, { news: false });
});

after(async () => {
  delete (globalThis as { __egytrendTestDatabase?: unknown }).__egytrendTestDatabase;
  await closeDb();
});

test("notif id is deterministic per (kind, phone, ref key) and unique across them", () => {
  const a1 = N.notifId("news", phoneVip, "http://example.test/1");
  const a2 = N.notifId("news", phoneVip, "http://example.test/1");
  assert.equal(a1, a2);
  assert.notEqual(a1, N.notifId("news", phoneFree, "http://example.test/1"));
  assert.notEqual(a1, N.notifId("price", phoneVip, "http://example.test/1"));
});

test("duplicate inserts for the same user + ref key are ignored", async () => {
  const input = { phone: phoneVip, kind: "news", title: "أ", body: "ب", refKey: "ref-one" };
  assert.equal(await N.insertDedupedNotification(input), true);
  assert.equal(await N.insertDedupedNotification(input), false);
  const id = N.notifId("news", phoneVip, "ref-one");
  const rows = await db.select().from(schema.userNotificationsTable).where((t) => eq(t.id, id));
  assert.equal(rows.length, 1);
});

test("delivery prefs default to on and persist per family", async () => {
  assert.deepEqual(await N.getNotifPrefs(phoneFree), { price: true, opps: true, news: true });
  const saved = await N.setNotifPrefs(phoneFree, { news: false });
  assert.deepEqual(saved, { price: true, opps: true, news: false });
  assert.deepEqual(await N.getNotifPrefs(phoneFree), { price: true, opps: true, news: false });
  const restored = await N.setNotifPrefs(phoneFree, { news: true, price: false });
  assert.deepEqual(restored, { price: false, opps: true, news: true });
  assert.equal(await N.notifPrefEnabled(phoneFree, "price"), false);
  assert.equal(await N.notifPrefEnabled(phoneFree, "news"), true);
  await N.setNotifPrefs(phoneFree, { price: true });
});

test("arabic normalization unifies hamza/alef forms and drops diacritics", () => {
  assert.equal(N.normalizeArabicText("البنك  التجارى الدولى"), "البنك التجاري الدولي");
  assert.equal(N.normalizeArabicText("أوراسكوم"), "اوراسكوم");
  assert.equal(N.normalizeArabicText("السّوق"), "السوق");
  assert.equal(N.normalizeArabicText("COMI"), "comi");
});

test("follow matching: full name, ticker, sector and stopword resistance", () => {
  const comi = new Set(["COMI"]);
  assert.deepEqual(N.matchFollowsInTitle("البنك التجاري الدولي يرفع أسعار الفائدة", comi), ["COMI"]);
  assert.deepEqual(N.matchFollowsInTitle("COMI shares post stronger quarter", comi), ["COMI"]);
  assert.deepEqual(N.matchFollowsInTitle("قطاع البنوك يسجل قفزة في التقييمات", comi), ["COMI"]);
  // "التجاري" is COMI's only distinctive name token (البنك/الدولي are
  // stopwords), so a story naming it matches — precision anchor for the name.
  assert.deepEqual(N.matchFollowsInTitle("البنك التجاري يدرس طرحًا", comi), ["COMI"]);
  // a generic banking story without the distinctive token does not match
  assert.deepEqual(N.matchFollowsInTitle("مصرف جديد يدرس طرحًا", comi), []);
  // single distinctive token of the name (للتكنولوجيا is a stopword)
  assert.deepEqual(N.matchFollowsInTitle("فوري تعلن عن نمو في الإيرادات", new Set(["FWRY"])), ["FWRY"]);
  // full name with a hamza variant in the story
  assert.deepEqual(N.matchFollowsInTitle("أرباح المصرية للاتصالات تقفز", new Set(["ETEL"])), ["ETEL"]);
  // unrelated story
  assert.deepEqual(N.matchFollowsInTitle("المركزي يثبت سعر الفائدة", comi), []);
  // a followed symbol never fires on another company's story
  assert.deepEqual(N.matchFollowsInTitle("شركة ثانية تستحوذ على عقار", new Set(["CISS"])), []);
});

test("follows are catalog-validated, capped, and replace as a whole", async () => {
  const ok = await N.setUserFollows(phoneFree, ["etel", "COMI"]);
  assert.deepEqual(ok, { follows: ["COMI", "ETEL"] });
  assert.deepEqual(await N.getUserFollows(phoneFree), ["COMI", "ETEL"]);
  // any non-catalog symbol (or empty string) rejects the whole update
  const bad = await N.setUserFollows(phoneFree, ["COMI", "FAKE9"]);
  assert.ok("error" in bad);
  const empty = await N.setUserFollows(phoneFree, ["COMI", ""]);
  assert.ok("error" in empty);
  // rejected updates leave the previous set intact
  assert.deepEqual(await N.getUserFollows(phoneFree), ["COMI", "ETEL"]);
  // the 100-symbol cap is enforced before catalog validation
  const tooMany = await N.setUserFollows(phoneFree, Array(101).fill("COMI"));
  assert.ok("error" in tooMany);
  // the real catalog fits under the cap, so a full-catalog sync succeeds
  const catalog = await N.setUserFollows(phoneFree, EGX_STOCKS.map((d) => d.sym));
  assert.ok("follows" in catalog);
  const replace = await N.setUserFollows(phoneFree, ["SWDY"]);
  assert.ok("follows" in replace);
  assert.deepEqual(await N.getUserFollows(phoneFree), ["SWDY"]);
});

test("list / read / delete are strictly scoped to the owner phone", async () => {
  await N.insertDedupedNotification({ phone: phoneVip, kind: "news", title: "لـ A", body: "أ", refKey: "owner-scope" });
  const id = N.notifId("news", phoneVip, "owner-scope");
  const listA = await N.listNotifications(phoneVip, 50);
  assert.equal(listA.notifications.some((n) => n.id === id), true);
  assert.equal(listA.unread >= 1, true);
  // other user cannot read it or delete it
  assert.equal(await N.markNotificationRead(phoneFree, id), false);
  assert.equal(await N.deleteNotification(phoneFree, id), false);
  // owner can
  assert.equal(await N.markNotificationRead(phoneVip, id), true);
  const afterRead = await N.listNotifications(phoneVip, 50);
  assert.equal(afterRead.notifications.find((n) => n.id === id)?.read, true);
  // mark-all only touches unread rows and reports the count
  await N.insertDedupedNotification({ phone: phoneVip, kind: "news", title: "ثاني", body: "ب", refKey: "owner-scope-2" });
  const marked = await N.markAllNotificationsRead(phoneVip);
  assert.ok(marked >= 1);
  const allRead = await N.listNotifications(phoneVip, 50);
  assert.equal(allRead.unread, 0);
  assert.equal(await N.markAllNotificationsRead(phoneVip), 0);
  assert.equal(await N.deleteNotification(phoneVip, id), true);
  const gone = await N.listNotifications(phoneVip, 50);
  assert.equal(gone.notifications.some((n) => n.id === id), false);
});

test("news cycle: outage inserts nothing, recovery with a fresh item does", async () => {
  const phone = "01110000009";
  await seedUser(phone, "متابع", "free");
  await N.setUserFollows(phone, ["COMI"]);
  const fresh = () => ({
    available: true,
    items: [{ title: "البنك التجاري الدولي يرفع أسعار الفائدة", link: "http://example.test/rec-1", pubDate: new Date(nowMs - 10 * 60_000).toUTCString(), sourceName: "المصدر التجريبي" }],
  });

  // outage: the provider throws, or reports unavailable, or has no items
  const threw = await N.runNewsNotificationCycle({ snapshot: async () => { throw new Error("feeds down"); } });
  assert.equal(threw.reason, "unavailable");
  assert.equal(threw.inserted, 0);
  const down = await N.runNewsNotificationCycle({ snapshot: async () => ({ available: false, items: [] }) });
  assert.equal(down.reason, "unavailable");
  const noSnap = await N.runNewsNotificationCycle({ snapshot: async () => null });
  assert.equal(noSnap.reason, "unavailable");
  const empty = await N.runNewsNotificationCycle({ snapshot: async () => ({ available: true, items: [] }) });
  assert.equal(empty.reason, "unavailable");
  // nothing was invented during the outage
  const midOutage = await db.select().from(schema.userNotificationsTable).where((t) => eq(t.phone, phone));
  assert.equal(midOutage.length, 0);

  // recovery: the fresh item arrives and is delivered once
  const first = await N.runNewsNotificationCycle({ snapshot: async () => fresh() });
  assert.deepEqual({ scanned: first.scanned, inserted: first.inserted, usersNotified: first.usersNotified }, { scanned: 1, inserted: 1, usersNotified: 1 });
  const rows = await db.select().from(schema.userNotificationsTable).where((t) => eq(t.phone, phone));
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /البنك التجاري الدولي/);
  assert.match(rows[0].body, /المصدر: المصدر التجريبي/);
  assert.match(rows[0].body, /يعني متابعتك: COMI/);
  // same item again (even after the outage window): deduped
  const second = await N.runNewsNotificationCycle({ snapshot: async () => fresh() });
  assert.equal(second.inserted, 0);
});

test("news cycle: no follows, stale/future/undated items, and per-family pref off", async () => {
  // clean slate: nobody follows anything yet
  await db.delete(schema.userFollowsTable);
  const nobody = "01110000010";
  await seedUser(nobody, "بدون متابعة", "free");
  const noFollows = await N.runNewsNotificationCycle({
    snapshot: async () => ({ available: true, items: [{ title: "خبر عام", link: "http://example.test/x", pubDate: new Date(nowMs - 60_000).toUTCString(), sourceName: "م" }] }),
  });
  assert.equal(noFollows.reason, "no_follows");
  assert.equal(noFollows.inserted, 0);

  const phone = "01110000011";
  await seedUser(phone, "متابع2", "free");
  await N.setUserFollows(phone, ["COMI"]);
  const items = [
    { title: "البنك التجاري الدولي يربح", link: "http://example.test/fresh", pubDate: new Date(nowMs - 5 * 60_000).toUTCString(), sourceName: "م1" },
    { title: "البنك التجاري الدولي قديم", link: "http://example.test/stale", pubDate: new Date(nowMs - 5 * 3600_000).toUTCString(), sourceName: "م1" },
    { title: "البنك التجاري الدولي مستقبل", link: "http://example.test/future", pubDate: new Date(nowMs + 60 * 60_000).toUTCString(), sourceName: "م1" },
    { title: "البنك التجاري الدولي بدون تاريخ", link: "http://example.test/undated", pubDate: "", sourceName: "م1" },
    { title: "خبر لا علاقة له", link: "http://example.test/none", pubDate: new Date(nowMs - 5 * 60_000).toUTCString(), sourceName: "م1" },
  ];
  const out = await N.runNewsNotificationCycle({ snapshot: async () => ({ available: true, items }) });
  assert.equal(out.scanned, 5);
  assert.equal(out.inserted, 1);
  const rows = await db.select().from(schema.userNotificationsTable).where((t) => eq(t.phone, phone));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actionUrl, null);

  // a VIP user who follows ETEL with news disabled gets nothing for ETEL news
  await N.setUserFollows(phoneVipNoNews, ["ETEL"]);
  const etelCycle = await N.runNewsNotificationCycle({
    snapshot: async () => ({ available: true, items: [{ title: "المصرية للاتصالات توسع شبكتها", link: "http://example.test/etel-1", pubDate: new Date(nowMs - 5 * 60_000).toUTCString(), sourceName: "م1" }] }),
  });
  assert.equal(etelCycle.inserted, 0);
  const forNoNews = await db.select().from(schema.userNotificationsTable).where((t) => eq(t.phone, phoneVipNoNews));
  assert.equal(forNoNews.length, 0);
});

test("opportunity notifications: VIP-only, pref-respecting, deduped per row", async () => {
  const row1 = { id: "opp-row-1", title: "تداول: شركة ترفع الحجز", summary: "حجم تداول مرتفع على بيانات حقيقية", createdAt: new Date(nowMs) };
  const row2 = { id: "opp-row-2", title: "فرصة ثانية", summary: "ملخص ثاني", createdAt: new Date(nowMs) };
  // two VIP users with opps enabled; the free user must not receive anything
  assert.equal(await N.notifyNewOpportunities([row1]), 2);
  const freeRows = await db.select().from(schema.userNotificationsTable).where((t) => eq(t.phone, phoneFree));
  assert.equal(freeRows.filter((r) => r.kind === "opportunity").length, 0);
  // same row on the next cycle: deduped
  assert.equal(await N.notifyNewOpportunities([row1]), 0);
  // pref off: only the other VIP receives row2
  await N.setNotifPrefs(phoneVip, { opps: false });
  assert.equal(await N.notifyNewOpportunities([row2]), 1);
  const vipNoNewsRows = await db.select().from(schema.userNotificationsTable).where((t) => eq(t.phone, phoneVipNoNews));
  assert.equal(vipNoNewsRows.filter((r) => r.kind === "opportunity" && r.title.includes("فرصة ثانية")).length, 1);
  // pref back on: the first VIP catches up on the missed row (dedup keeps one)
  await N.setNotifPrefs(phoneVip, { opps: true });
  assert.equal(await N.notifyNewOpportunities([row2]), 1);
  const vipRows = await db.select().from(schema.userNotificationsTable).where((t) => eq(t.phone, phoneVip));
  assert.equal(vipRows.filter((r) => r.kind === "opportunity").length, 2);
});

test("price alert insertion respects the price delivery pref (insertAlertNotification)", async () => {
  const candidate = {
    id: "pa-1", userId: 77, phone: phoneFree, name: "تجريبي",
    email: "pa-test@example.test", symbol: "SWDY", condition: "price_below" as const,
    targetValue: "10", emailEnabled: true,
  };
  const now = new Date(nowMs);
  await N.setNotifPrefs(phoneFree, { price: true });
  await (await import("../routes/price-alerts")).insertAlertNotification(candidate, 10, 9.8, now);
  let priceRows = (await db.select().from(schema.userNotificationsTable).where((t) => eq(t.phone, phoneFree)))
    .filter((r) => r.kind === "price_alert" && (r.title || "").includes("SWDY"));
  assert.equal(priceRows.length, 1);
  assert.match(priceRows[0].title, /تنبيه SWDY/);
  assert.match(priceRows[0].body, /هبوط دون|هبط دون/);
  assert.match(priceRows[0].body, /9.8/);
  assert.equal(priceRows[0].actionUrl, null);
  // a later re-trigger (different verification time) appends a new row —
  // the single-fire guarantee lives in the alert lifecycle (status → triggered)
  await (await import("../routes/price-alerts")).insertAlertNotification(candidate, 10, 9.7, new Date(nowMs + 1000));
  priceRows = (await db.select().from(schema.userNotificationsTable).where((t) => eq(t.phone, phoneFree)))
    .filter((r) => r.kind === "price_alert" && (r.title || "").includes("SWDY"));
  assert.equal(priceRows.length, 2);
  // pref off -> nothing is written
  await N.setNotifPrefs(phoneFree, { price: false });
  await (await import("../routes/price-alerts")).insertAlertNotification({ ...candidate, symbol: "ETEL" }, 10, 9.9, new Date(nowMs + 2000));
  const etelRows = (await db.select().from(schema.userNotificationsTable).where((t) => eq(t.phone, phoneFree)))
    .filter((r) => r.kind === "price_alert" && (r.title || "").includes("ETEL"));
  assert.equal(etelRows.length, 0);
});
