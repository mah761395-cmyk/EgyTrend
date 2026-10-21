import { and, eq, sql } from "drizzle-orm";
import { userOnboardingTable, userPriceAlertsTable } from "@workspace/db/schema";
import { db } from "@workspace/db";
import { freeTrialAccountStatus } from "./free-trials";
import { readReferralSettings } from "./referrals";
import { getVipEntitlement } from "./userAuth";
import { scopeAllows } from "./trial-settings";

export const ONBOARDING_TOUR_VERSION = 1;
/** Bump to replay the VIP tour for every VIP account that already acked an older one. */
export const VIP_ONBOARDING_TOUR_VERSION = 1;

export type OnboardingEvent = "watchlist_progress" | "notifications_enabled" | "news_explored";
export type OnboardingTourAction = "started" | "completed" | "skipped";
/** `user` is the general platform tour; `vip` is the VIP welcome tour. */
export type OnboardingTourKind = "user" | "vip";
export type OnboardingResetTarget = OnboardingTourKind;

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

/** The VIP features this account may actually open, using the same scope
 * predicate as the server gates (`hasVipFeature`). The browser uses this only
 * to avoid advertising a tour step for a feature the server would refuse. */
function vipFeatureProjection(entitlement: Awaited<ReturnType<typeof getVipEntitlement>>) {
  const allowed = (feature: string): boolean => {
    if (!entitlement.active) return false;
    if (entitlement.subscriptionType !== "trial") return true;
    return scopeAllows(entitlement.trialFeatureScope, feature);
  };
  return {
    portfolio: allowed("portfolio"),
    priceAlerts: allowed("price_alerts"),
    calculators: allowed("calculators"),
    ai: allowed("ai"),
    opportunities: allowed("opportunities"),
    indicators: allowed("indicators"),
    /* Markets, reports and subscription management ship inside the VIP area
     * itself and are not individually scoped features. */
    markets: entitlement.active,
    reports: entitlement.active,
  };
}

function vipTourState(record: OnboardingRecord, entitlement: Awaited<ReturnType<typeof getVipEntitlement>>) {
  const acked = record.vipTourVersion >= VIP_ONBOARDING_TOUR_VERSION
    && ["completed", "skipped"].includes(record.vipTourStatus);
  return {
    version: record.vipTourVersion,
    status: record.vipTourStatus,
    /* Shown once per VIP tour version, and only while VIP is actually active. */
    shouldShow: entitlement.active && !acked,
    startedAt: iso(record.vipTourStartedAt),
    completedAt: iso(record.vipTourCompletedAt),
    skippedAt: iso(record.vipTourSkippedAt),
  };
}

/** All values are derived from durable account state or conservative UI events;
 * none of them controls permissions, billing, or a VIP entitlement. */
export async function onboardingState(userId: number, now = new Date()) {
  const record = await ensureOnboardingRecord(userId, now);
  const [trial, referralSettings, alertRows, entitlement] = await Promise.all([
    freeTrialAccountStatus(userId, now),
    readReferralSettings(),
    db.select({ count: sql<number>`count(*)` }).from(userPriceAlertsTable).where(and(
      eq(userPriceAlertsTable.userId, userId), eq(userPriceAlertsTable.status, "active"),
    )),
    getVipEntitlement({ sub: userId }, now),
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
    vip: {
      active: entitlement.active,
      planNameAr: entitlement.planNameAr,
      subscriptionType: entitlement.subscriptionType,
      expiresAt: iso(entitlement.expiresAt),
    },
    vipTour: vipTourState(record, entitlement),
    vipFeatures: vipFeatureProjection(entitlement),
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

export async function setOnboardingTourAction(
  userId: number,
  action: OnboardingTourAction,
  now = new Date(),
  tour: OnboardingTourKind = "user",
) {
  const record = await ensureOnboardingRecord(userId, now);
  if (tour === "vip") {
    if (action === "started") {
      await db.update(userOnboardingTable).set({
        vipTourStartedAt: record.vipTourStartedAt || now, updatedAt: now,
      }).where(eq(userOnboardingTable.userId, userId));
    } else if (action === "completed") {
      await db.update(userOnboardingTable).set({
        vipTourVersion: VIP_ONBOARDING_TOUR_VERSION, vipTourStatus: "completed",
        vipTourCompletedAt: now, vipTourSkippedAt: null, updatedAt: now,
      }).where(eq(userOnboardingTable.userId, userId));
    } else {
      await db.update(userOnboardingTable).set({
        vipTourVersion: VIP_ONBOARDING_TOUR_VERSION, vipTourStatus: "skipped",
        vipTourSkippedAt: now, vipTourCompletedAt: null, updatedAt: now,
      }).where(eq(userOnboardingTable.userId, userId));
    }
    return onboardingState(userId, now);
  }
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

/** Replays the requested guided tour only. Completed real actions stay visible
 * in the checklist, so reset cannot fabricate progress or erase user data. */
export async function resetOnboardingTour(
  userId: number,
  now = new Date(),
  tour: OnboardingResetTarget = "user",
) {
  await ensureOnboardingRecord(userId, now);
  if (tour === "vip") {
    await db.update(userOnboardingTable).set({
      vipTourVersion: 0, vipTourStatus: "new", vipTourStartedAt: null,
      vipTourCompletedAt: null, vipTourSkippedAt: null, updatedAt: now,
    }).where(eq(userOnboardingTable.userId, userId));
  } else {
    await db.update(userOnboardingTable).set({
      tourVersion: ONBOARDING_TOUR_VERSION,
      tourStatus: "new",
      tourStartedAt: null,
      tourCompletedAt: null,
      tourSkippedAt: null,
      updatedAt: now,
    }).where(eq(userOnboardingTable.userId, userId));
  }
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
