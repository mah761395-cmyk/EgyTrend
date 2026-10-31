/**
 * Notification center — server-side logic.
 *
 * Rows live in the shared `user_notifications` table (per-phone, as the
 * payment-lifecycle and price-alert paths already write them). This module
 * adds: deterministic dedup ids, per-user delivery preferences, the followed
 * EGX symbols used for news matching, and the two ambient generation cycles
 * (news stories that affect a followed stock or sector, and new
 * server-evaluated opportunities).
 *
 * Honesty rules: a notification is only created from data the server actually
 * received (a parsed news item with a real pubDate and source, or a persisted
 * opportunity row). No invented titles, times or sources — when the source
 * is unavailable the cycle reports `unavailable` and inserts nothing.
 */
import crypto from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  appUsersTable,
  userFollowsTable,
  userNotificationPrefsTable,
  userNotificationsTable,
} from "@workspace/db/schema";
import { hasVipFeature } from "./userAuth";
import { EGX_STOCKS } from "./market-data/catalog";
import { logger } from "./logger";

export const NOTIF_PREF_KINDS = ["price", "opps", "news"] as const;
export type NotifPrefKind = (typeof NOTIF_PREF_KINDS)[number];

const MAX_FOLLOWS = 100;
const LIST_LIMIT_MAX = 200;

const CATALOG_BY_SYM = new Map(EGX_STOCKS.map((d) => [d.sym.toUpperCase(), d]));

/** Generic words that never identify a company on their own. */
const NAME_STOPWORDS = new Set([
  "البنك", "مصرف", "مصر", "المصرية", "المصري", "القابضة", "الدولية", "الدولي",
  "للتكنولوجيا", "المالية", "شركة", "المصرية",
]);

/* ── deterministic dedup ─────────────────────────────────────────────── */

/**
 * Deterministic row id per (kind, phone, refKey): the same real event can
 * never create a second notification, no matter how many times a cycle
 * runs or how many scheduler invocations overlap.
 */
export function notifId(kind: string, phone: string, refKey: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(`${kind}:${phone}:${refKey}`)
    .digest("hex")
    .slice(0, 32);
  return `kn-${kind}-${hash}`;
}

/**
 * Inserts a notification unless the identical event already notified this
 * user (PK conflict → no-op). Returns whether a row was created.
 */
export async function insertDedupedNotification(input: {
  phone: string;
  kind: string;
  title: string;
  body: string;
  refKey: string;
  actionUrl?: string | null;
  actionLabel?: string | null;
}): Promise<boolean> {
  const id = notifId(input.kind, input.phone, input.refKey);
  const inserted = await db
    .insert(userNotificationsTable)
    .values({
      id,
      phone: input.phone,
      kind: input.kind,
      title: input.title.slice(0, 300),
      body: input.body.slice(0, 1000),
      actionUrl: input.actionUrl ?? null,
      actionLabel: input.actionLabel ? input.actionLabel.slice(0, 40) : null,
    })
    .onConflictDoNothing()
    .returning({ id: userNotificationsTable.id });
  return inserted.length > 0;
}

/* ── delivery preferences ────────────────────────────────────────────── */

export async function getNotifPrefs(phone: string): Promise<Record<NotifPrefKind, boolean>> {
  const prefs: Record<NotifPrefKind, boolean> = { price: true, opps: true, news: true };
  const rows = await db
    .select()
    .from(userNotificationPrefsTable)
    .where(eq(userNotificationPrefsTable.phone, phone));
  for (const row of rows) {
    if ((NOTIF_PREF_KINDS as readonly string[]).includes(row.kind)) {
      prefs[row.kind as NotifPrefKind] = row.enabled;
    }
  }
  return prefs;
}

export async function setNotifPrefs(
  phone: string,
  updates: Partial<Record<NotifPrefKind, boolean>>,
): Promise<Record<NotifPrefKind, boolean>> {
  const now = new Date();
  for (const kind of NOTIF_PREF_KINDS) {
    const value = updates[kind];
    if (typeof value !== "boolean") continue;
    await db
      .insert(userNotificationPrefsTable)
      .values({ phone, kind, enabled: value, updatedAt: now })
      .onConflictDoUpdate({
        target: [userNotificationPrefsTable.phone, userNotificationPrefsTable.kind],
        set: { enabled: value, updatedAt: now },
      });
  }
  return getNotifPrefs(phone);
}

export async function notifPrefEnabled(phone: string, kind: NotifPrefKind): Promise<boolean> {
  return (await getNotifPrefs(phone))[kind];
}

/* ── followed symbols (news matching input) ──────────────────────────── */

export function normalizeFollowSymbol(value: unknown): string | null {
  const sym = String(value ?? "").trim().toUpperCase();
  return CATALOG_BY_SYM.has(sym) ? sym : null;
}

export async function getUserFollows(phone: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(userFollowsTable)
    .where(eq(userFollowsTable.phone, phone));
  return rows.map((row) => row.symbol).sort();
}

/** Full-replace sync from the client's watchlist. Catalog-validated. */
export async function setUserFollows(
  phone: string,
  values: unknown,
): Promise<{ follows: string[] } | { error: string }> {
  if (!Array.isArray(values) || values.length > MAX_FOLLOWS) return { error: "invalid" };
  const wanted = new Set<string>();
  for (const value of values) {
    const sym = normalizeFollowSymbol(value);
    if (!sym) return { error: "invalid" };
    wanted.add(sym);
  }
  const current = await db
    .select()
    .from(userFollowsTable)
    .where(eq(userFollowsTable.phone, phone));
  const currentSet = new Set(current.map((row) => row.symbol));
  for (const sym of currentSet) {
    if (!wanted.has(sym)) {
      await db.delete(userFollowsTable).where(
        and(eq(userFollowsTable.phone, phone), eq(userFollowsTable.symbol, sym)),
      );
    }
  }
  for (const sym of wanted) {
    if (!currentSet.has(sym)) {
      await db.insert(userFollowsTable).values({ phone, symbol: sym }).onConflictDoNothing();
    }
  }
  return { follows: [...wanted].sort() };
}

/* ── reading / managing the user's feed ──────────────────────────────── */

export type PublicNotification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  actionUrl: string | null;
  actionLabel: string | null;
  read: boolean;
  createdAt: string;
};

export async function listNotifications(phone: string, limit = 100): Promise<{
  notifications: PublicNotification[];
  unread: number;
}> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), LIST_LIMIT_MAX);
  const rows = await db
    .select()
    .from(userNotificationsTable)
    .where(eq(userNotificationsTable.phone, phone))
    .orderBy(desc(userNotificationsTable.createdAt))
    .limit(safeLimit);
  return {
    notifications: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      actionUrl: row.actionUrl,
      actionLabel: row.actionLabel,
      read: row.readAt !== null,
      createdAt: row.createdAt.toISOString(),
    })),
    unread: rows.filter((row) => row.readAt === null).length,
  };
}

/** Owner-scoped: the phone comes from the verified session, never the body. */
export async function markNotificationRead(phone: string, id: string): Promise<boolean> {
  const updated = await db
    .update(userNotificationsTable)
    .set({ readAt: new Date() })
    .where(
      and(eq(userNotificationsTable.id, id), eq(userNotificationsTable.phone, phone)),
    )
    .returning({ id: userNotificationsTable.id });
  return updated.length > 0;
}

export async function markAllNotificationsRead(phone: string): Promise<number> {
  const updated = await db
    .update(userNotificationsTable)
    .set({ readAt: new Date() })
    .where(
      and(eq(userNotificationsTable.phone, phone), isNull(userNotificationsTable.readAt)),
    )
    .returning({ id: userNotificationsTable.id });
  return updated.length;
}

export async function deleteNotification(phone: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(userNotificationsTable)
    .where(and(eq(userNotificationsTable.id, id), eq(userNotificationsTable.phone, phone)))
    .returning({ id: userNotificationsTable.id });
  return deleted.length > 0;
}

/* ── Arabic-aware news matching ──────────────────────────────────────── */

/** Normalizes Arabic (diacritics, alef/ya/ta-variants) for containment checks. */
export function normalizeArabicText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function distinctiveTokens(name: string): string[] {
  return normalizeArabicText(name)
    .split(" ")
    .filter((token) => token.length >= 4 && !NAME_STOPWORDS.has(token));
}

/**
 * Which followed symbols does this story title refer to? Matches on the
 * company's catalog name, its ticker, or its sector (a story about "البنوك"
 * affects a user following a bank). Precision over recall: generic words
 * from the stopword list never identify a company on their own.
 */
export function matchFollowsInTitle(title: string, follows: ReadonlySet<string>): string[] {
  const norm = normalizeArabicText(title);
  if (!norm || !follows.size) return [];
  const matched: string[] = [];
  for (const sym of follows) {
    const def = CATALOG_BY_SYM.get(sym);
    if (!def) continue;
    const name = normalizeArabicText(def.name);
    if (name.length >= 4 && norm.includes(name)) {
      matched.push(sym);
      continue;
    }
    if (norm.includes(def.sym.toLowerCase())) {
      matched.push(sym);
      continue;
    }
    const tokens = distinctiveTokens(def.name);
    if (tokens.length === 1 && norm.includes(tokens[0])) {
      matched.push(sym);
      continue;
    }
    if (tokens.length > 1 && tokens.every((token) => norm.includes(token))) {
      matched.push(sym);
      continue;
    }
    /* Sector stories affect every followed company of that sector (a "بنوك"
     * story reaches a user following COMI) — checked whenever the name and
     * ticker did not already match. */
    const sector = normalizeArabicText(def.sector);
    if (sector.length >= 3 && norm.includes(sector)) matched.push(sym);
  }
  return [...new Set(matched)];
}

/* ── ambient cycles (scheduled, server-side) ─────────────────────────── */

export type NewsCycleItem = {
  title: string;
  link: string;
  /** ISO/HTTP date as published by the source; unparsable ⇒ skipped. */
  pubDate: string;
  sourceName: string;
};

export type NewsCycleResult = {
  scanned: number;
  inserted: number;
  usersNotified: number;
  reason?: "unavailable" | "no_follows";
};

export type NewsSnapshotLike = {
  available: boolean;
  items: NewsCycleItem[];
};

/**
 * One scheduled pass: recent, dated news items × users' followed symbols.
 * The snapshot provider is injected so tests (and the route) control the
 * data source; the route feeds it the real getNewsSnapshot() output.
 */
export async function runNewsNotificationCycle(deps: {
  snapshot?: () => Promise<NewsSnapshotLike | null>;
  now?: Date;
  windowMs?: number;
} = {}): Promise<NewsCycleResult> {
  const now = deps.now ?? new Date();
  const windowMs = deps.windowMs ?? 2 * 60 * 60 * 1000;
  const snapshotProvider = deps.snapshot ?? (async () => null);

  let snap: NewsSnapshotLike | null = null;
  try {
    snap = await snapshotProvider();
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "news cycle: snapshot unavailable");
    return { scanned: 0, inserted: 0, usersNotified: 0, reason: "unavailable" };
  }
  if (!snap || !snap.available || !snap.items.length) {
    return { scanned: 0, inserted: 0, usersNotified: 0, reason: "unavailable" };
  }

  const followRows = await db.select().from(userFollowsTable);
  const followsByPhone = new Map<string, Set<string>>();
  for (const row of followRows) {
    if (!followsByPhone.has(row.phone)) followsByPhone.set(row.phone, new Set<string>());
    followsByPhone.get(row.phone)!.add(row.symbol);
  }
  if (!followsByPhone.size) {
    return { scanned: snap.items.length, inserted: 0, usersNotified: 0, reason: "no_follows" };
  }

  const prefsCache = new Map<string, Record<NotifPrefKind, boolean>>();
  let inserted = 0;
  const usersNotified = new Set<string>();

  for (const item of snap.items) {
    const published = Date.parse(item.pubDate);
    /* No real published time ⇒ no notification (never invent freshness). */
    if (!Number.isFinite(published)) continue;
    if (published > now.getTime() + 10 * 60_000) continue;
    if (now.getTime() - published > windowMs) continue;

    const title = String(item.title || "").trim();
    if (!title) continue;
    const sourceName = String(item.sourceName || "").trim();
    const refKey = `news:${crypto.createHash("sha1").update(item.link || title).digest("hex").slice(0, 32)}`;
    const sourceLine = `المصدر: ${sourceName || "مصدر موثّق"} · ${new Date(published).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`;

    for (const [phone, follows] of followsByPhone) {
      const matched = matchFollowsInTitle(title, follows);
      if (!matched.length) continue;
      let prefs = prefsCache.get(phone);
      if (!prefs) {
        prefs = await getNotifPrefs(phone);
        prefsCache.set(phone, prefs);
      }
      if (!prefs.news) continue;
      const ok = await insertDedupedNotification({
        phone,
        kind: "news",
        title: `📰 ${title.slice(0, 120)}`,
        body: `${title.slice(0, 560)}\n${sourceLine}\nيعني متابعتك: ${matched.join("، ")}`,
        refKey,
      });
      if (ok) {
        inserted += 1;
        usersNotified.add(phone);
      }
    }
  }
  return { scanned: snap.items.length, inserted, usersNotified: usersNotified.size };
}

/**
 * Notifies active VIP users about freshly persisted opportunity rows
 * (signal cards and descriptive cards share the same honesty: they only
 * exist because the engine wrote them from verified market data).
 */
export async function notifyNewOpportunities(
  rows: ReadonlyArray<{ id: string; title: string; summary: string; createdAt?: Date | string | null }>,
): Promise<number> {
  if (!rows.length) return 0;
  const users = await db
    .select({ id: appUsersTable.id, phone: appUsersTable.phone })
    .from(appUsersTable)
    .where(eq(appUsersTable.status, "active"));
  const prefsCache = new Map<string, Record<NotifPrefKind, boolean>>();
  let inserted = 0;
  for (const user of users) {
    let vip = false;
    try {
      vip = await hasVipFeature({ sub: user.id }, "opportunities");
    } catch {
      vip = false;
    }
    if (!vip) continue;
    let prefs = prefsCache.get(user.phone);
    if (!prefs) {
      prefs = await getNotifPrefs(user.phone);
      prefsCache.set(user.phone, prefs);
    }
    if (!prefs.opps) continue;
    for (const row of rows) {
      const created = row.createdAt ? new Date(row.createdAt) : new Date();
      const ok = await insertDedupedNotification({
        phone: user.phone,
        kind: "opportunity",
        title: `💡 ${String(row.title || "").slice(0, 280)}`,
        body: `${String(row.summary || "").slice(0, 560)}\nتُقيَّم من الخادم على بيانات السوق المرخصة · ${created.toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`,
        refKey: `opp:${row.id}`,
      });
      if (ok) inserted += 1;
    }
  }
  return inserted;
}
