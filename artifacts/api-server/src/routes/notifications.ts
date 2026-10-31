import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { appUsersTable } from "@workspace/db/schema";
import { currentAppOwner } from "../lib/userAuth";
import {
  deleteNotification,
  getNotifPrefs,
  getUserFollows,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NOTIF_PREF_KINDS,
  runNewsNotificationCycle,
  setUserFollows,
  setNotifPrefs,
  type NewsSnapshotLike,
  type NotifPrefKind,
} from "../lib/notifications";
import { getNewsSnapshot } from "./news";
import { logger } from "../lib/logger";

const router = Router();

const ID_RX = /^[a-z0-9-]{12,96}$/i;

/**
 * The notification feed is per-account: the phone always comes from the
 * verified session row — never from the request body or params.
 */
async function ownerPhone(req: Request): Promise<string | null> {
  const owner = await currentAppOwner(req);
  if (!owner) return null;
  const rows = await db
    .select({ phone: appUsersTable.phone })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, owner.sub))
    .limit(1);
  const row = rows[0];
  if (!row || !row.phone) return null;
  return row.phone;
}

/* Server-authored deep links only — the same edge rule as the payments
 * notifications endpoint, so a stored value can never become an open
 * redirect. */
function safeAction(value: string | null): string | null {
  return value && /^\/(?!\/)[a-zA-Z0-9_?=&%./-]{1,300}$/.test(value) ? value : null;
}

router.get("/notifications", async (req: Request, res: Response) => {
  const phone = await ownerPhone(req);
  if (!phone) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  try {
    const { notifications, unread } = await listNotifications(phone, 100);
    res.json({
      status: "ok",
      unread,
      notifications: notifications.map((n) => ({
        ...n,
        actionUrl: safeAction(n.actionUrl),
      })),
    });
  } catch (error) {
    logger.error({ err: error }, "notifications list failed");
    res.status(500).json({ status: "error", message: "تعذر تحميل الإشعارات حاليًا" });
  }
});

router.post("/notifications/read-all", async (req: Request, res: Response) => {
  const phone = await ownerPhone(req);
  if (!phone) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  try {
    const marked = await markAllNotificationsRead(phone);
    res.json({ status: "ok", marked });
  } catch (error) {
    logger.error({ err: error }, "notifications mark-all failed");
    res.status(500).json({ status: "error", message: "تعذر تحديث حالة الإشعارات حاليًا" });
  }
});

router.post("/notifications/:id/read", async (req: Request, res: Response) => {
  const phone = await ownerPhone(req);
  if (!phone) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const id = String(req.params["id"] || "").trim();
  if (!ID_RX.test(id)) {
    res.status(400).json({ status: "error", message: "معرّف الإشعار غير صحيح" });
    return;
  }
  try {
    const ok = await markNotificationRead(phone, id);
    if (!ok) {
      res.status(404).json({ status: "error", message: "الإشعار غير موجود" });
      return;
    }
    res.json({ status: "ok", read: true });
  } catch (error) {
    logger.error({ err: error }, "notification mark-read failed");
    res.status(500).json({ status: "error", message: "تعذر تحديث حالة الإشعار حاليًا" });
  }
});

router.delete("/notifications/:id", async (req: Request, res: Response) => {
  const phone = await ownerPhone(req);
  if (!phone) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const id = String(req.params["id"] || "").trim();
  if (!ID_RX.test(id)) {
    res.status(400).json({ status: "error", message: "معرّف الإشعار غير صحيح" });
    return;
  }
  try {
    const ok = await deleteNotification(phone, id);
    if (!ok) {
      res.status(404).json({ status: "error", message: "الإشعار غير موجود" });
      return;
    }
    res.json({ status: "ok", deleted: true });
  } catch (error) {
    logger.error({ err: error }, "notification delete failed");
    res.status(500).json({ status: "error", message: "تعذر حذف الإشعار حاليًا" });
  }
});

/* ── delivery preferences ────────────────────────────────────────────── */

function parsePrefsBody(raw: unknown): Partial<Record<NotifPrefKind, boolean>> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const out: Partial<Record<NotifPrefKind, boolean>> = {};
  for (const kind of NOTIF_PREF_KINDS) {
    const value = body[kind];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return null;
    out[kind] = value;
  }
  return Object.keys(out).length ? out : null;
}

router.get("/notifications/prefs", async (req: Request, res: Response) => {
  const phone = await ownerPhone(req);
  if (!phone) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  try {
    res.json({ status: "ok", prefs: await getNotifPrefs(phone) });
  } catch (error) {
    logger.error({ err: error }, "notification prefs read failed");
    res.status(500).json({ status: "error", message: "تعذر تحميل تفضيلات الإشعارات حاليًا" });
  }
});

router.put("/notifications/prefs", async (req: Request, res: Response) => {
  const phone = await ownerPhone(req);
  if (!phone) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const updates = parsePrefsBody(req.body);
  if (!updates) {
    res.status(400).json({ status: "error", message: "بيانات التفضيلات غير صحيحة" });
    return;
  }
  try {
    res.json({ status: "ok", prefs: await setNotifPrefs(phone, updates) });
  } catch (error) {
    logger.error({ err: error }, "notification prefs save failed");
    res.status(500).json({ status: "error", message: "تعذر حفظ تفضيلات الإشعارات حاليًا" });
  }
});

/* ── followed symbols (news matching input) ──────────────────────────── */

router.get("/notifications/follows", async (req: Request, res: Response) => {
  const phone = await ownerPhone(req);
  if (!phone) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  try {
    res.json({ status: "ok", follows: await getUserFollows(phone) });
  } catch (error) {
    logger.error({ err: error }, "follows read failed");
    res.status(500).json({ status: "error", message: "تعذر تحميل المتابَعة حاليًا" });
  }
});

router.put("/notifications/follows", async (req: Request, res: Response) => {
  const phone = await ownerPhone(req);
  if (!phone) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const result = await setUserFollows(phone, req.body?.follows ?? req.body);
  if ("error" in result) {
    res.status(400).json({ status: "error", message: "رموز غير مدعومة — استخدم رموز EGX من قائمة الأسهم" });
    return;
  }
  res.json({ status: "ok", follows: result.follows });
});

/* ── scheduled news cycle ──────────────────────────────────────────────
   Runs from the Vercel cron (GET + platform markers, same pattern as the
   opportunities/backups crons) or the shared cron secret over POST. It only
   reads the real aggregated news snapshot — when that snapshot is
   unavailable the cycle reports it and inserts nothing. */

function vercelCronAuthorized(req: Request): boolean {
  const userAgent = String(req.get("user-agent") || "").toLowerCase();
  const schedule = String(req.get("x-vercel-cron-schedule") || "").trim();
  return userAgent.startsWith("vercel-cron") && schedule.length > 0;
}

function secretCronAuthorized(req: Request): boolean {
  const configured = (process.env["MARKET_SNAPSHOT_CRON_SECRET"] || "").trim();
  const supplied = String(req.get("x-cron-secret") || req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!configured || !supplied) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function realNewsSnapshot(): Promise<NewsSnapshotLike | null> {
  const snap = await getNewsSnapshot();
  if (!snap) return null;
  if (snap.availability !== "available") return { available: false, items: [] };
  return {
    available: true,
    items: snap.items.map((item) => ({
      title: item.title,
      link: item.link,
      pubDate: item.pubDate,
      sourceName: item.source.name,
    })),
  };
}

async function runNewsCycleHandler(req: Request, res: Response): Promise<void> {
  try {
    const result = await runNewsNotificationCycle({ snapshot: realNewsSnapshot });
    logger.info(result, "notification news cycle complete");
    res.json({ status: "ok", ...result });
  } catch (error) {
    logger.error({ err: error }, "notification news cycle failed");
    res.status(503).json({ status: "error", message: "news cycle unavailable" });
  }
}

router.get("/notifications/internal/run", (req: Request, res: Response) => {
  if (!vercelCronAuthorized(req)) {
    res.status(404).json({ status: "error", message: "not found" });
    return;
  }
  void runNewsCycleHandler(req, res);
});

router.post("/notifications/internal/run", (req: Request, res: Response) => {
  if (!secretCronAuthorized(req)) {
    res.status(404).json({ status: "error", message: "not found" });
    return;
  }
  void runNewsCycleHandler(req, res);
});

export default router;
