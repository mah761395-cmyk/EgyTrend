import { and, eq, sql } from "drizzle-orm";
import { userOnboardingTable, userPriceAlertsTable } from "@workspace/db/schema";
import { db } from "@workspace/db";
import { freeTrialAccountStatus } from "./free-trials";
import { readReferralSettings } from "./referrals";

export const ONBOARDING_TOUR_VERSION = 1;

export type OnboardingEvent = "watchlist_progress" | "notifications_enabled" | "news_explored";
export type OnboardingTourAction = "started" | "completed" | "skipped";

type OnboardingRecord = typeof userOnboardingTable.$inferSelect;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

async function ensureOnboardingRecord(userId: number, now: Date): Promise<OnboardingRecord> {
  await db.insert(userOnboardingTable).values({
    userId,
    tourVersion: ONBOARDING_TOUR_VERSION,
    tourStatus: "new",
    watchlistCount: 0,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  const [record] = await db.select().from(userOnboardingTable).where(eq(userOnboardingTable.userId, userId)).limit(1);
  if (!record) throw new Error("Unable to initialize onboarding state");
  if (record.tourVersion < ONBOARDING_TOUR_VERSION) {
    const [upgraded] = await db.update(userOnboardingTable).set({
      tourVersion: ONBOARDING_TOUR_VERSION, tourStatus: "new", tourStartedAt: null,
      tourCompletedAt: null, tourSkippedAt: null, updatedAt: now,
    }).where(eq(userOnboardingTable.userId, userId)).returning();
    if (upgraded) return upgraded;
  }
  return record;
}

function trialChecklistState(trial: Awaited<ReturnType<typeof freeTrialAccountStatus>>) {
  const completed = trial.active || ["already_active", "already_claimed", "already_paid"].includes(String(trial.reason || ""));
  const action = trial.canStart ? "profile_trial" : "profile";
  const description = completed
    ? (trial.active ? "تجربة VIP مفعّلة لحسابك الآن." : "هذه الخطوة مكتملة لحسابك.")
    : trial.canStart
      ? `ابدأ التجربة المتاحة لمدة ${trial.settings.durationDays} يومًا بلا بيانات دفع أو تجديد تلقائي.`
      : "تعرض صفحة الحساب الشروط الفعلية المتبقية، مثل تأكيد البريد إن لزم.";
  return { id: "free_trial", title: "ابدأ تجربتك المجانية", description, completed, action, available: trial.canStart };
}

/** All values are derived from durable account state or conservative UI events;
 * none of them controls permissions, billing, or a VIP entitlement. */
export async function onboardingState(userId: number, now = new Date()) {
  const record = await ensureOnboardingRecord(userId, now);
  const [trial, referralSettings, alertRows] = await Promise.all([
    freeTrialAccountStatus(userId, now),
    readReferralSettings(),
    db.select({ count: sql<number>`count(*)` }).from(userPriceAlertsTable).where(and(
      eq(userPriceAlertsTable.userId, userId), eq(userPriceAlertsTable.status, "active"),
    )),
  ]);
  const activeAlerts = Number(alertRows[0]?.count || 0);
  const watchlistCount = Math.max(0, Math.min(3, Number(record.watchlistCount || 0)));
  const notificationsComplete = Boolean(record.notificationsEnabledAt) || activeAlerts > 0;
  const checklist = [
    {
      id: "watchlist",
      title: "أضف 3 أسهم إلى قائمتك",
      description: watchlistCount >= 3 ? "سُجّل اكتمال هدف ثلاثة عناصر في تقدّم حسابك." : "اختر نجمة المتابعة بجانب ثلاثة أسهم أو أصول تهمك.",
      completed: watchlistCount >= 3,
      progress: { current: watchlistCount, target: 3 },
      action: "markets",
    },
    {
      id: "notifications",
      title: "فعّل الإشعارات",
      description: notificationsComplete ? "سُجّل تفعيل إشعار أو تنبيه لهذا الحساب." : "فعّل إشعارات المتصفح أو أنشئ تنبيه سعر عندما تكون الميزة متاحة لحسابك.",
      completed: notificationsComplete,
      action: "notifications",
    },
    {
      id: "news",
      title: "جرّب الأخبار",
      description: record.newsExploredAt ? "فتحت خبرًا من المصادر المعتمدة." : "افتح خبرًا للاطلاع على المصدر ووقت النشر المتاحين.",
      completed: Boolean(record.newsExploredAt),
      action: "news",
    },
    ...(trial.settings.enabled ? [trialChecklistState(trial)] : []),
  ];
  return {
    asOf: now.toISOString(),
    tour: {
      version: record.tourVersion,
      status: record.tourStatus,
      shouldShow: record.tourStatus === "new",
      startedAt: iso(record.tourStartedAt),
      completedAt: iso(record.tourCompletedAt),
      skippedAt: iso(record.tourSkippedAt),
    },
    features: {
      freeTrial: {
        enabled: trial.settings.enabled,
        durationDays: trial.settings.durationDays,
        canStart: trial.canStart,
        active: trial.active,
        reason: trial.reason,
      },
      referrals: { enabled: referralSettings.enabled },
    },
    checklist,
  };
}

export async function setOnboardingTourAction(userId: number, action: OnboardingTourAction, now = new Date()) {
  const record = await ensureOnboardingRecord(userId, now);
  if (action === "started") {
    await db.update(userOnboardingTable).set({
      tourStartedAt: record.tourStartedAt || now,
      updatedAt: now,
    }).where(eq(userOnboardingTable.userId, userId));
  } else if (action === "completed") {
    await db.update(userOnboardingTable).set({
      tourStatus: "completed", tourCompletedAt: now, tourSkippedAt: null, updatedAt: now,
    }).where(eq(userOnboardingTable.userId, userId));
  } else {
    await db.update(userOnboardingTable).set({
      tourStatus: "skipped", tourSkippedAt: now, tourCompletedAt: null, updatedAt: now,
    }).where(eq(userOnboardingTable.userId, userId));
  }
  return onboardingState(userId, now);
}

/** Replays the guided tour only. Completed real actions stay visible in the
 * checklist, so reset cannot fabricate progress or erase user data. */
export async function resetOnboardingTour(userId: number, now = new Date()) {
  await ensureOnboardingRecord(userId, now);
  await db.update(userOnboardingTable).set({
    tourVersion: ONBOARDING_TOUR_VERSION,
    tourStatus: "new",
    tourStartedAt: null,
    tourCompletedAt: null,
    tourSkippedAt: null,
    updatedAt: now,
  }).where(eq(userOnboardingTable.userId, userId));
  return onboardingState(userId, now);
}

export async function recordOnboardingEvent(userId: number, event: OnboardingEvent, payload: unknown, now = new Date()) {
  const record = await ensureOnboardingRecord(userId, now);
  if (event === "watchlist_progress") {
    const raw = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>).count : null;
    const count = Number(raw);
    if (!Number.isSafeInteger(count) || count < 0 || count > 100) return null;
    const next = Math.max(Number(record.watchlistCount || 0), Math.min(3, count));
    await db.update(userOnboardingTable).set({
      watchlistCount: next,
      watchlistCompletedAt: next >= 3 ? record.watchlistCompletedAt || now : null,
      updatedAt: now,
    }).where(eq(userOnboardingTable.userId, userId));
  } else if (event === "notifications_enabled") {
    await db.update(userOnboardingTable).set({
      notificationsEnabledAt: record.notificationsEnabledAt || now,
      updatedAt: now,
    }).where(eq(userOnboardingTable.userId, userId));
  } else {
    await db.update(userOnboardingTable).set({
      newsExploredAt: record.newsExploredAt || now,
      updatedAt: now,
    }).where(eq(userOnboardingTable.userId, userId));
  }
  return onboardingState(userId, now);
}
