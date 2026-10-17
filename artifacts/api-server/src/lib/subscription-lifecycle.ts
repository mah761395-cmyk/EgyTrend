import crypto from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  appSettingsTable,
  appUsersTable,
  db,
  subscriptionLifecycleEventsTable,
  subscriptionPlansTable,
  subscriptionRemindersSentTable,
  type SubscriptionReminderContent,
  userNotificationsTable,
  userSubscriptionsTable,
} from "@workspace/db";
import { escapeHtml, isSmtpConfigured, sendMail, type MailResult } from "./mailer";
import {
  CAIRO_TIME_ZONE,
  cairoCalendarDaysUntil,
  cairoWallClockToUtc,
  calculateGraceEnd,
  calculateSubscriptionEnd,
  formatCairoDate,
} from "./subscription-time";

export const SUBSCRIPTION_LIFECYCLE_SETTINGS_KEY = "subscription_lifecycle_v1";
const MAX_EMAIL_ATTEMPTS = 3;
const EMAIL_LEASE_MS = 15 * 60 * 1000;
const EMAIL_BATCH_SIZE = 100;

export type SubscriptionLifecycleSettings = {
  /** Zero is the safe/default entitlement policy. Maximum prevents accidental multi-month access. */
  graceDays: number;
  /** Marketing is opt-in at the platform level; transactional expiry notices are never gated by it. */
  winbackMarketingEnabled: boolean;
};

export const DEFAULT_SUBSCRIPTION_LIFECYCLE_SETTINGS: SubscriptionLifecycleSettings = {
  graceDays: 0,
  winbackMarketingEnabled: false,
};

type ReminderType =
  | "monthly_7d" | "monthly_3d" | "monthly_1d"
  | "annual_30d" | "annual_14d" | "annual_7d" | "annual_1d"
  | "expiry" | "winback_3d" | "manual";

type ReminderClass = "transactional" | "marketing";

type SubscriptionCandidate = {
  id: string;
  userId: number;
  planKey: string;
  planNameAr: string;
  planDurationMonths: number;
  planFeatures: string[] | null;
  status: string;
  cycleId: string;
  startsAt: Date;
  expiresAt: Date;
  graceEndsAt: Date | null;
  phone: string;
  name: string;
  email: string | null;
  userStatus: string;
};

type ReminderRow = {
  id: string;
  subscriptionId: string;
  subscriptionCycleId: string;
  userId: number;
  reminderType: string;
  reminderClass: string;
  targetEndsAt: Date;
  deliveryStatus: string;
  content: SubscriptionReminderContent;
  inAppNotificationId: string | null;
  inAppSentAt: Date | null;
  emailStatus: string;
  emailAttempts: number;
  emailNextAttemptAt: Date | null;
  emailClaimToken: string | null;
  emailClaimedAt: Date | null;
  emailSentAt: Date | null;
  emailLastError: string | null;
};

export type ReminderPreview = {
  userId: number;
  subscriptionId: string;
  cycleId: string;
  reminderType: ReminderType;
  reminderClass: ReminderClass;
  daysUntilExpiry: number;
  title: string;
  wouldSuppress: ReminderType[];
};

export type SubscriptionLifecycleRunResult = {
  now: string;
  timezone: typeof CAIRO_TIME_ZONE;
  dryRun: boolean;
  inspected: number;
  transitionedToGrace: number;
  transitionedToExpired: number;
  queued: number;
  suppressed: number;
  inAppDelivered: number;
  emailSent: number;
  emailRetrying: number;
  emailFailed: number;
  emailUnavailable: number;
  previews: ReminderPreview[];
};

export type LifecycleMailer = (to: string, subject: string, html: string) => Promise<MailResult>;

function cleanSettings(raw: unknown): SubscriptionLifecycleSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_SUBSCRIPTION_LIFECYCLE_SETTINGS };
  const value = raw as Record<string, unknown>;
  const days = Number(value.graceDays);
  return {
    graceDays: Number.isInteger(days) && days >= 0 && days <= 31 ? days : DEFAULT_SUBSCRIPTION_LIFECYCLE_SETTINGS.graceDays,
    winbackMarketingEnabled: value.winbackMarketingEnabled === true,
  };
}

export function validateSubscriptionLifecycleSettings(input: unknown): SubscriptionLifecycleSettings | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const days = Number(value.graceDays);
  if (!Number.isInteger(days) || days < 0 || days > 31) return null;
  if (typeof value.winbackMarketingEnabled !== "boolean") return null;
  return { graceDays: days, winbackMarketingEnabled: value.winbackMarketingEnabled };
}

export async function readSubscriptionLifecycleSettings(): Promise<SubscriptionLifecycleSettings> {
  const [row] = await db.select({ value: appSettingsTable.value }).from(appSettingsTable)
    .where(eq(appSettingsTable.key, SUBSCRIPTION_LIFECYCLE_SETTINGS_KEY)).limit(1);
  if (!row?.value) return { ...DEFAULT_SUBSCRIPTION_LIFECYCLE_SETTINGS };
  try { return cleanSettings(JSON.parse(row.value)); } catch { return { ...DEFAULT_SUBSCRIPTION_LIFECYCLE_SETTINGS }; }
}

export async function saveSubscriptionLifecycleSettings(settings: SubscriptionLifecycleSettings, now = new Date()): Promise<void> {
  await db.insert(appSettingsTable).values({
    key: SUBSCRIPTION_LIFECYCLE_SETTINGS_KEY,
    value: JSON.stringify(settings),
    updatedAt: now,
  }).onConflictDoUpdate({
    target: appSettingsTable.key,
    set: { value: JSON.stringify(settings), updatedAt: now },
  });
}

export function createSubscriptionCycleId(userId: number, paymentRequestId: string): string {
  const safePaymentId = String(paymentRequestId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!safePaymentId) throw new Error("A server payment request id is required for a subscription cycle");
  return `subcycle-${userId}-${safePaymentId}`;
}

/** Kept public so approval code and fake-clock tests share the same rule. */
export function calculateApprovedSubscriptionEnd(base: Date, durationMonths: number): Date {
  return calculateSubscriptionEnd(base, durationMonths);
}

export function calculateSubscriptionGraceEnd(expiresAt: Date, graceDays: number): Date | null {
  return calculateGraceEnd(expiresAt, graceDays);
}

function isMonthly(candidate: Pick<SubscriptionCandidate, "planKey" | "planDurationMonths">): boolean {
  return candidate.planDurationMonths === 1 || /month|شهري/i.test(candidate.planKey);
}

function scheduleFor(candidate: Pick<SubscriptionCandidate, "planKey" | "planDurationMonths">): Array<{ type: ReminderType; days: number }> {
  if (isMonthly(candidate)) {
    return [
      { type: "monthly_7d", days: 7 },
      { type: "monthly_3d", days: 3 },
      { type: "monthly_1d", days: 1 },
    ];
  }
  return [
    { type: "annual_30d", days: 30 },
    { type: "annual_14d", days: 14 },
    { type: "annual_7d", days: 7 },
    { type: "annual_1d", days: 1 },
  ];
}

/**
 * Returns one customer-visible reminder at most. Any older missed threshold is
 * reserved as suppressed so the next daily run cannot drip a backlog to the
 * same person. `existingTypes` includes queued/suppressed rows by design.
 */
export function chooseReminderForDay(input: {
  candidate: Pick<SubscriptionCandidate, "planKey" | "planDurationMonths" | "expiresAt">;
  now: Date;
  existingTypes: Iterable<string>;
  winbackMarketingEnabled: boolean;
}): { type: ReminderType; reminderClass: ReminderClass; daysUntilExpiry: number; suppress: ReminderType[] } | null {
  const existing = new Set(input.existingTypes);
  const daysUntilExpiry = cairoCalendarDaysUntil(input.candidate.expiresAt, input.now);
  const schedule = scheduleFor(input.candidate);
  const missingSchedule = schedule.filter((entry) => !existing.has(entry.type));

  if (daysUntilExpiry > 0) {
    const due = missingSchedule.filter((entry) => daysUntilExpiry <= entry.days).sort((a, b) => a.days - b.days);
    if (!due.length) return null;
    const selected = due[0]!;
    return {
      type: selected.type,
      reminderClass: "transactional",
      daysUntilExpiry,
      suppress: due.filter((entry) => entry.days > selected.days).map((entry) => entry.type),
    };
  }

  if (daysUntilExpiry === 0) {
    if (existing.has("expiry")) return null;
    return {
      type: "expiry",
      reminderClass: "transactional",
      daysUntilExpiry,
      /* A normal expiry-day send must leave the day+3 winback eligible. */
      suppress: missingSchedule.map((entry) => entry.type),
    };
  }

  /* If a run was missed, expiry is the only first catch-up notification. */
  if (!existing.has("expiry")) {
    return {
      type: "expiry",
      reminderClass: "transactional",
      daysUntilExpiry,
      suppress: missingSchedule.map((entry) => entry.type).concat(
        !existing.has("winback_3d") ? ["winback_3d"] : [],
      ),
    };
  }

  if (isMonthly(input.candidate) && daysUntilExpiry <= -3 && input.winbackMarketingEnabled && !existing.has("winback_3d")) {
    return { type: "winback_3d", reminderClass: "marketing", daysUntilExpiry, suppress: [] };
  }

  return null;
}

function renewalActionUrl(planKey: string): string {
  /* This is intentionally a same-origin path, never a user/admin supplied URL. */
  return `/vip?plan=${encodeURIComponent(planKey)}&renew=1`;
}

function configuredAppBaseUrl(): string | null {
  const raw = String(process.env["APP_BASE_URL"] || "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.toString().replace(/\/$/, "");
  } catch { /* invalid configuration is handled as an unavailable delivery channel */ }
  return null;
}

function appBaseUrl(): string {
  /* Development's local-only mail sink can use localhost. Production must set
   * APP_BASE_URL or the outbox marks email unavailable instead of sending a
   * CTA that cannot work for the member. */
  return configuredAppBaseUrl() || "http://localhost:3000";
}

function subscriptionEmailLinkReady(): boolean {
  return process.env.NODE_ENV !== "production" || configuredAppBaseUrl() !== null;
}

function featureText(features: string[] | null): string {
  const clean = (features || []).map((feature) => String(feature || "").trim()).filter(Boolean).slice(0, 4);
  return clean.length ? ` وتشمل مزاياك الحالية: ${clean.join("، ")}.` : "";
}

function reminderLabel(type: ReminderType): string {
  if (type === "winback_3d") return "وحشتنا";
  if (type === "expiry") return "انتهاء الاشتراك";
  if (type === "manual") return "تذكير بالتجديد";
  return "تذكير بالتجديد";
}

export function buildSubscriptionReminderContent(input: {
  candidate: Pick<SubscriptionCandidate, "planKey" | "planNameAr" | "planFeatures" | "expiresAt" | "graceEndsAt">;
  type: ReminderType;
}): SubscriptionReminderContent {
  const date = formatCairoDate(input.candidate.expiresAt);
  const actionUrl = renewalActionUrl(input.candidate.planKey);
  const actionLabel = "جدّد الآن";
  const features = featureText(input.candidate.planFeatures);
  const preserved = "ستبقى قوائمك ومحفظتك وتنبيهاتك وسيناريوهاتك محفوظة، لكنها ستُقفل حتى التجديد.";
  const grace = input.candidate.graceEndsAt
    ? ` فترة السماح مضبوطة حتى ${formatCairoDate(input.candidate.graceEndsAt)}.`
    : "";
  let body: string;
  if (input.type === "expiry") {
    body = input.candidate.graceEndsAt
      ? `انتهت مدة اشتراك ${input.candidate.planNameAr} يوم ${date}. ستبقى مزاياك متاحة خلال فترة السماح حتى ${formatCairoDate(input.candidate.graceEndsAt)}، وبعدها يعود الحساب للخطة المجانية وتُقفل مزايا VIP.${features} ${preserved}`
      : `انتهت مدة اشتراك ${input.candidate.planNameAr} يوم ${date}. عاد الحساب للخطة المجانية وتُقفل مزايا VIP.${features} ${preserved}`;
  } else if (input.type === "winback_3d") {
    body = `وحشتنا! انتهى اشتراك ${input.candidate.planNameAr} يوم ${date}. جدّد وقت ما تكون جاهزًا لاستعادة مزايا VIP فورًا. ${preserved}`;
  } else {
    body = `ينتهي اشتراك ${input.candidate.planNameAr} يوم ${date}.${grace} بعد الانتهاء يعود الحساب للخطة المجانية وتُقفل مزايا VIP.${features} ${preserved}`;
  }
  const title = `${input.type === "winback_3d" ? "💚 " : "⏰ "}${reminderLabel(input.type)}`;
  const absoluteUrl = `${appBaseUrl()}${actionUrl}`;
  const html = `<!doctype html><html dir="rtl" lang="ar"><body style="margin:0;background:#f4f6f5;padding:22px;font-family:Tahoma,Arial,sans-serif;color:#172033"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px"><h2 style="margin:0 0 14px;color:#047857">${escapeHtml(title)} — EgyTrend</h2><p style="font-size:15px;line-height:1.9">${escapeHtml(body)}</p><p style="text-align:center;margin:24px 0"><a href="${escapeHtml(absoluteUrl)}" style="display:inline-block;background:#059669;color:#fff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:10px">${actionLabel}</a></p><p style="font-size:12px;color:#6b7280;line-height:1.7">هذا تنبيه اشتراك من EgyTrend. لا تُحذف بياناتك عند انتهاء الاشتراك.</p></div></body></html>`;
  return {
    title,
    body,
    actionUrl,
    actionLabel,
    emailSubject: `EgyTrend — ${reminderLabel(input.type)}`,
    emailHtml: html,
    transactional: input.type !== "winback_3d",
  };
}

async function subscriptionCandidates(): Promise<SubscriptionCandidate[]> {
  const rows = await db.select({
    id: userSubscriptionsTable.id,
    userId: userSubscriptionsTable.userId,
    planKey: userSubscriptionsTable.planKey,
    planNameAr: userSubscriptionsTable.planNameAr,
    planDurationMonths: userSubscriptionsTable.planDurationMonths,
    planFeatures: userSubscriptionsTable.planFeatures,
    status: userSubscriptionsTable.status,
    cycleId: userSubscriptionsTable.cycleId,
    startsAt: userSubscriptionsTable.startsAt,
    expiresAt: userSubscriptionsTable.expiresAt,
    graceEndsAt: userSubscriptionsTable.graceEndsAt,
    phone: appUsersTable.phone,
    name: appUsersTable.name,
    email: appUsersTable.email,
    userStatus: appUsersTable.status,
  }).from(userSubscriptionsTable)
    .innerJoin(appUsersTable, eq(userSubscriptionsTable.userId, appUsersTable.id))
    .where(and(
      inArray(userSubscriptionsTable.status, ["active", "grace", "expired"]),
      eq(appUsersTable.status, "active"),
    ));
  return rows as SubscriptionCandidate[];
}

async function reminderTypesByCycle(cycleIds: string[]): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (!cycleIds.length) return result;
  const rows = await db.select({
    cycleId: subscriptionRemindersSentTable.subscriptionCycleId,
    type: subscriptionRemindersSentTable.reminderType,
  }).from(subscriptionRemindersSentTable)
    .where(inArray(subscriptionRemindersSentTable.subscriptionCycleId, cycleIds));
  for (const row of rows) {
    const types = result.get(row.cycleId) || new Set<string>();
    types.add(row.type);
    result.set(row.cycleId, types);
  }
  return result;
}

function reminderId(cycleId: string, type: ReminderType): string {
  return `subrem-${crypto.createHash("sha256").update(`${cycleId}:${type}`).digest("hex").slice(0, 30)}`;
}

async function reserveReminder(input: {
  candidate: SubscriptionCandidate;
  type: ReminderType;
  reminderClass: ReminderClass;
  now: Date;
  deliveryStatus?: "queued" | "suppressed";
}): Promise<boolean> {
  const content = buildSubscriptionReminderContent({ candidate: input.candidate, type: input.type });
  const suppressed = input.deliveryStatus === "suppressed";
  const inserted = await db.insert(subscriptionRemindersSentTable).values({
    id: reminderId(input.candidate.cycleId, input.type),
    subscriptionId: input.candidate.id,
    subscriptionCycleId: input.candidate.cycleId,
    userId: input.candidate.userId,
    reminderType: input.type,
    reminderClass: input.reminderClass,
    targetEndsAt: input.candidate.expiresAt,
    deliveryStatus: suppressed ? "suppressed" : "queued",
    content,
    emailStatus: suppressed ? "suppressed" : "pending",
    emailNextAttemptAt: suppressed ? null : input.now,
    createdAt: input.now,
    updatedAt: input.now,
  }).onConflictDoNothing().returning({ id: subscriptionRemindersSentTable.id });
  return inserted.length > 0;
}

function lifecycleStateAt(candidate: SubscriptionCandidate, now: Date): "active" | "grace" | "expired" {
  if (candidate.expiresAt.getTime() > now.getTime()) return "active";
  if (candidate.graceEndsAt && candidate.graceEndsAt.getTime() > now.getTime()) return "grace";
  return "expired";
}

async function transitionEntitlements(candidates: SubscriptionCandidate[], now: Date, dryRun: boolean): Promise<{ grace: number; expired: number }> {
  let grace = 0;
  let expired = 0;
  for (const candidate of candidates) {
    const desired = lifecycleStateAt(candidate, now);
    if (desired === candidate.status || desired === "active") continue;
    if (desired === "grace") grace += 1;
    if (desired === "expired") expired += 1;
    if (dryRun) continue;

    await db.transaction(async (tx) => {
      const changed = await tx.update(userSubscriptionsTable).set({
        status: desired,
        updatedAt: now,
      }).where(and(
        eq(userSubscriptionsTable.id, candidate.id),
        eq(userSubscriptionsTable.status, candidate.status),
      )).returning({ id: userSubscriptionsTable.id });
      if (!changed.length) return;
      if (desired === "expired") {
        await tx.update(appUsersTable).set({ plan: "free", vipExpiresAt: candidate.expiresAt, updatedAt: now })
          .where(eq(appUsersTable.id, candidate.userId));
      }
      await tx.insert(subscriptionLifecycleEventsTable).values({
        id: `subevent-${crypto.createHash("sha256").update(`${candidate.cycleId}:${desired}`).digest("hex").slice(0, 30)}`,
        userId: candidate.userId,
        subscriptionId: candidate.id,
        subscriptionCycleId: candidate.cycleId,
        eventType: desired === "grace" ? "grace_started" : "expired",
        planKey: candidate.planKey,
        occurredAt: now,
        createdAt: now,
      }).onConflictDoNothing();
    });
  }
  return { grace, expired };
}

async function deliverInApp(now: Date): Promise<number> {
  const rows = await db.select({
    reminder: subscriptionRemindersSentTable,
    phone: appUsersTable.phone,
  }).from(subscriptionRemindersSentTable)
    .innerJoin(appUsersTable, eq(subscriptionRemindersSentTable.userId, appUsersTable.id))
    .where(and(
      eq(subscriptionRemindersSentTable.deliveryStatus, "queued"),
      isNull(subscriptionRemindersSentTable.inAppSentAt),
      eq(appUsersTable.status, "active"),
    )).limit(EMAIL_BATCH_SIZE) as Array<{ reminder: ReminderRow; phone: string }>;
  let delivered = 0;
  for (const row of rows) {
    const notificationId = row.reminder.inAppNotificationId || `sub-notification-${row.reminder.id}`;
    try {
      await db.transaction(async (tx) => {
        await tx.insert(userNotificationsTable).values({
          id: notificationId,
          phone: row.phone,
          kind: "subscription",
          title: row.reminder.content.title,
          body: row.reminder.content.body,
          actionUrl: row.reminder.content.actionUrl,
          actionLabel: row.reminder.content.actionLabel,
          createdAt: now,
        }).onConflictDoNothing();
        const updated = await tx.update(subscriptionRemindersSentTable).set({
          inAppNotificationId: notificationId,
          inAppSentAt: now,
          deliveryStatus: "delivered",
          updatedAt: now,
        }).where(and(
          eq(subscriptionRemindersSentTable.id, row.reminder.id),
          eq(subscriptionRemindersSentTable.deliveryStatus, "queued"),
          isNull(subscriptionRemindersSentTable.inAppSentAt),
        )).returning({ id: subscriptionRemindersSentTable.id });
        if (updated.length) delivered += 1;
      });
    } catch {
      /* The queued reservation is retained. A later scheduler run safely retries it. */
    }
  }
  return delivered;
}

function validRecipient(email: string | null): email is string {
  return Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

function retryAfter(now: Date, attempted: number): Date {
  const minutes = attempted <= 1 ? 5 : 30;
  return new Date(now.getTime() + minutes * 60 * 1000);
}

async function processEmailOutbox(now: Date, mailer: LifecycleMailer, mailConfigured = isSmtpConfigured(), linkReady = subscriptionEmailLinkReady()): Promise<{ sent: number; retrying: number; failed: number; unavailable: number }> {
  const staleLease = new Date(now.getTime() - EMAIL_LEASE_MS);
  const rows = await db.select({
    reminder: subscriptionRemindersSentTable,
    email: appUsersTable.email,
  }).from(subscriptionRemindersSentTable)
    .innerJoin(appUsersTable, eq(subscriptionRemindersSentTable.userId, appUsersTable.id))
    .where(and(
      eq(subscriptionRemindersSentTable.deliveryStatus, "delivered"),
      or(
        and(eq(subscriptionRemindersSentTable.emailStatus, "pending"), lte(subscriptionRemindersSentTable.emailNextAttemptAt, now)),
        and(eq(subscriptionRemindersSentTable.emailStatus, "sending"), lte(subscriptionRemindersSentTable.emailClaimedAt, staleLease)),
      ),
    )).orderBy(subscriptionRemindersSentTable.createdAt).limit(EMAIL_BATCH_SIZE) as Array<{ reminder: ReminderRow; email: string | null }>;

  let sent = 0;
  let retrying = 0;
  let failed = 0;
  let unavailable = 0;
  for (const row of rows) {
    if (!validRecipient(row.email)) {
      const updated = await db.update(subscriptionRemindersSentTable).set({
        emailStatus: "unavailable",
        emailLastError: "recipient_unavailable",
        emailNextAttemptAt: null,
        updatedAt: now,
      }).where(and(
        eq(subscriptionRemindersSentTable.id, row.reminder.id),
        inArray(subscriptionRemindersSentTable.emailStatus, ["pending", "sending"]),
      )).returning({ id: subscriptionRemindersSentTable.id });
      unavailable += updated.length;
      continue;
    }
    if (!mailConfigured || !linkReady) {
      const updated = await db.update(subscriptionRemindersSentTable).set({
        emailStatus: "unavailable",
        emailLastError: !mailConfigured ? "smtp_not_configured" : "app_base_url_not_configured",
        emailNextAttemptAt: null,
        updatedAt: now,
      }).where(and(
        eq(subscriptionRemindersSentTable.id, row.reminder.id),
        inArray(subscriptionRemindersSentTable.emailStatus, ["pending", "sending"]),
      )).returning({ id: subscriptionRemindersSentTable.id });
      unavailable += updated.length;
      continue;
    }

    const token = crypto.randomUUID();
    const attempted = row.reminder.emailAttempts + 1;
    const claimed = await db.update(subscriptionRemindersSentTable).set({
      emailStatus: "sending",
      emailAttempts: attempted,
      emailClaimToken: token,
      emailClaimedAt: now,
      updatedAt: now,
    }).where(and(
      eq(subscriptionRemindersSentTable.id, row.reminder.id),
      eq(subscriptionRemindersSentTable.deliveryStatus, "delivered"),
      or(
        eq(subscriptionRemindersSentTable.emailStatus, "pending"),
        and(eq(subscriptionRemindersSentTable.emailStatus, "sending"), lte(subscriptionRemindersSentTable.emailClaimedAt, staleLease)),
      ),
    )).returning({ id: subscriptionRemindersSentTable.id });
    if (!claimed.length) continue;

    let delivery: MailResult;
    try { delivery = await mailer(row.email, row.reminder.content.emailSubject, row.reminder.content.emailHtml); }
    catch { delivery = { delivered: false, error: "send_failed" }; }
    if (delivery.delivered) {
      const updated = await db.update(subscriptionRemindersSentTable).set({
        emailStatus: "sent",
        emailSentAt: now,
        emailNextAttemptAt: null,
        emailLastError: null,
        emailClaimToken: null,
        updatedAt: now,
      }).where(and(
        eq(subscriptionRemindersSentTable.id, row.reminder.id),
        eq(subscriptionRemindersSentTable.emailClaimToken, token),
        eq(subscriptionRemindersSentTable.emailStatus, "sending"),
      )).returning({ id: subscriptionRemindersSentTable.id });
      sent += updated.length;
      continue;
    }

    const terminalUnavailable = delivery.error === "smtp_not_configured" || delivery.error === "nodemailer_missing";
    const terminalFailure = attempted >= MAX_EMAIL_ATTEMPTS;
    const nextStatus = terminalUnavailable ? "unavailable" : terminalFailure ? "failed" : "pending";
    const updated = await db.update(subscriptionRemindersSentTable).set({
      emailStatus: nextStatus,
      emailNextAttemptAt: nextStatus === "pending" ? retryAfter(now, attempted) : null,
      emailLastError: terminalUnavailable ? String(delivery.error) : "send_failed",
      emailClaimToken: null,
      updatedAt: now,
    }).where(and(
      eq(subscriptionRemindersSentTable.id, row.reminder.id),
      eq(subscriptionRemindersSentTable.emailClaimToken, token),
      eq(subscriptionRemindersSentTable.emailStatus, "sending"),
    )).returning({ id: subscriptionRemindersSentTable.id });
    if (nextStatus === "pending") retrying += updated.length;
    else if (nextStatus === "failed") failed += updated.length;
    else unavailable += updated.length;
  }
  return { sent, retrying, failed, unavailable };
}

/**
 * Idempotent daily lifecycle worker. It uses a supplied clock in tests/admin
 * dry-runs and never relies on a process-wide fake Date. Normal invocations
 * reserve durable rows first, deliver in-app independently, then process the
 * e-mail outbox so SMTP failures cannot block entitlement expiry.
 */
export async function runSubscriptionLifecycle(options: {
  now?: Date;
  dryRun?: boolean;
  mailer?: LifecycleMailer;
} = {}): Promise<SubscriptionLifecycleRunResult> {
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid lifecycle clock");
  const dryRun = options.dryRun === true;
  const settings = await readSubscriptionLifecycleSettings();
  const candidates = await subscriptionCandidates();
  const transitions = await transitionEntitlements(candidates, now, dryRun);
  const typesByCycle = await reminderTypesByCycle(candidates.map((candidate) => candidate.cycleId));
  const previews: ReminderPreview[] = [];
  let queued = 0;
  let suppressed = 0;

  for (const candidate of candidates) {
    const existing = typesByCycle.get(candidate.cycleId) || new Set<string>();
    const choice = chooseReminderForDay({
      candidate,
      now,
      existingTypes: existing,
      winbackMarketingEnabled: settings.winbackMarketingEnabled,
    });
    if (!choice) continue;
    const content = buildSubscriptionReminderContent({ candidate, type: choice.type });
    previews.push({
      userId: candidate.userId,
      subscriptionId: candidate.id,
      cycleId: candidate.cycleId,
      reminderType: choice.type,
      reminderClass: choice.reminderClass,
      daysUntilExpiry: choice.daysUntilExpiry,
      title: content.title,
      wouldSuppress: choice.suppress,
    });
    if (dryRun) continue;

    if (await reserveReminder({ candidate, type: choice.type, reminderClass: choice.reminderClass, now })) {
      queued += 1;
      existing.add(choice.type);
    }
    for (const type of choice.suppress) {
      if (existing.has(type)) continue;
      const reminderClass: ReminderClass = type === "winback_3d" ? "marketing" : "transactional";
      if (await reserveReminder({ candidate, type, reminderClass, now, deliveryStatus: "suppressed" })) suppressed += 1;
      existing.add(type);
    }
  }

  if (dryRun) {
    return {
      now: now.toISOString(), timezone: CAIRO_TIME_ZONE, dryRun: true, inspected: candidates.length,
      transitionedToGrace: transitions.grace, transitionedToExpired: transitions.expired,
      queued: 0, suppressed: 0, inAppDelivered: 0, emailSent: 0, emailRetrying: 0, emailFailed: 0, emailUnavailable: 0,
      previews: previews.slice(0, 100),
    };
  }

  const inAppDelivered = await deliverInApp(now);
  const emails = await processEmailOutbox(now, options.mailer || sendMail, options.mailer ? true : isSmtpConfigured());
  return {
    now: now.toISOString(), timezone: CAIRO_TIME_ZONE, dryRun: false, inspected: candidates.length,
    transitionedToGrace: transitions.grace, transitionedToExpired: transitions.expired,
    queued, suppressed, inAppDelivered,
    emailSent: emails.sent, emailRetrying: emails.retrying, emailFailed: emails.failed, emailUnavailable: emails.unavailable,
    previews: previews.slice(0, 100),
  };
}

/** Admin-only manual reminder: one durable, idempotent manual row per paid cycle. */
export async function queueManualSubscriptionReminder(subscriptionId: string, now = new Date()): Promise<{
  status: "queued" | "already_queued" | "not_eligible" | "not_found";
  result?: SubscriptionLifecycleRunResult;
}> {
  const candidates = await subscriptionCandidates();
  const candidate = candidates.find((entry) => entry.id === subscriptionId);
  if (!candidate) return { status: "not_found" };
  const days = cairoCalendarDaysUntil(candidate.expiresAt, now);
  if (days < 0 || days > 7 || candidate.status === "expired") return { status: "not_eligible" };
  const inserted = await reserveReminder({ candidate, type: "manual", reminderClass: "transactional", now });
  if (!inserted) return { status: "already_queued" };
  const inAppDelivered = await deliverInApp(now);
  const emails = await processEmailOutbox(now, sendMail);
  return {
    status: "queued",
    result: {
      now: now.toISOString(), timezone: CAIRO_TIME_ZONE, dryRun: false, inspected: 1,
      transitionedToGrace: 0, transitionedToExpired: 0, queued: 1, suppressed: 0, inAppDelivered,
      emailSent: emails.sent, emailRetrying: emails.retrying, emailFailed: emails.failed, emailUnavailable: emails.unavailable,
      previews: [],
    },
  };
}

export type ExpiringSubscriptionAdminRow = {
  subscriptionId: string;
  userId: number;
  name: string;
  phone: string;
  email: string | null;
  planKey: string;
  planNameAr: string;
  endsAt: Date;
  graceEndsAt: Date | null;
  daysUntilExpiry: number;
  status: string;
  cycleId: string;
  emailHealth: "healthy" | "retrying" | "failed" | "unavailable" | "none";
};

export async function listExpiringSubscriptions(now = new Date()): Promise<ExpiringSubscriptionAdminRow[]> {
  const candidates = await subscriptionCandidates();
  const emailRows = await db.select({
    cycleId: subscriptionRemindersSentTable.subscriptionCycleId,
    emailStatus: subscriptionRemindersSentTable.emailStatus,
  }).from(subscriptionRemindersSentTable)
    .where(inArray(subscriptionRemindersSentTable.subscriptionCycleId, candidates.map((candidate) => candidate.cycleId).length
      ? candidates.map((candidate) => candidate.cycleId) : ["__none__"]));
  const healthByCycle = new Map<string, ExpiringSubscriptionAdminRow["emailHealth"]>();
  for (const row of emailRows) {
    const prior = healthByCycle.get(row.cycleId) || "none";
    const health = row.emailStatus === "failed" ? "failed"
      : row.emailStatus === "unavailable" ? "unavailable"
        : row.emailStatus === "pending" || row.emailStatus === "sending" ? "retrying"
          : "healthy";
    const order: Record<ExpiringSubscriptionAdminRow["emailHealth"], number> = { none: 0, healthy: 1, retrying: 2, unavailable: 3, failed: 4 };
    if (order[health] >= order[prior]) healthByCycle.set(row.cycleId, health);
  }
  return candidates
    .map((candidate) => ({
      subscriptionId: candidate.id,
      userId: candidate.userId,
      name: candidate.name,
      phone: candidate.phone,
      email: candidate.email,
      planKey: candidate.planKey,
      planNameAr: candidate.planNameAr,
      endsAt: candidate.expiresAt,
      graceEndsAt: candidate.graceEndsAt,
      daysUntilExpiry: cairoCalendarDaysUntil(candidate.expiresAt, now),
      status: lifecycleStateAt(candidate, now),
      cycleId: candidate.cycleId,
      emailHealth: healthByCycle.get(candidate.cycleId) || "none",
    }))
    .filter((row) => row.daysUntilExpiry >= 0 && row.daysUntilExpiry <= 7)
    .sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());
}

function cairoMonthBounds(now: Date): { start: Date; end: Date } {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: CAIRO_TIME_ZONE, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit" });
  const p = formatter.formatToParts(now);
  const year = Number(p.find((part) => part.type === "year")?.value);
  const month = Number(p.find((part) => part.type === "month")?.value);
  const next = new Date(Date.UTC(year, month, 1));
  return {
    start: cairoWallClockToUtc({ year, month, day: 1, hour: 0, minute: 0, second: 0 }),
    end: cairoWallClockToUtc({
      year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: 1,
      hour: 0, minute: 0, second: 0,
    }),
  };
}

export async function subscriptionAdminSummary(now = new Date()): Promise<{
  asOf: string;
  timezone: typeof CAIRO_TIME_ZONE;
  expiringWithin7Days: number;
  expiredThisMonth: number;
  renewalEventsThisMonth: number;
  renewalRate: number | null;
  expectedRenewalRevenue: number | null;
  expectedRenewalRevenueBasis: "current_active_plan_prices" | "unavailable";
  emailFailures: number;
}> {
  const [expiring, bounds, failures] = await Promise.all([
    listExpiringSubscriptions(now),
    Promise.resolve(cairoMonthBounds(now)),
    db.select({ count: sql<number>`count(*)` }).from(subscriptionRemindersSentTable)
      .where(inArray(subscriptionRemindersSentTable.emailStatus, ["failed", "unavailable"])),
  ]);
  const events = await db.select({ eventType: subscriptionLifecycleEventsTable.eventType }).from(subscriptionLifecycleEventsTable)
    .where(and(
      inArray(subscriptionLifecycleEventsTable.eventType, ["expired", "renewed"]),
      gte(subscriptionLifecycleEventsTable.occurredAt, bounds.start),
      lt(subscriptionLifecycleEventsTable.occurredAt, bounds.end),
    ));
  const expiredThisMonth = events.filter((event) => event.eventType === "expired").length;
  const renewalEventsThisMonth = events.filter((event) => event.eventType === "renewed").length;
  const renewalRate = expiredThisMonth + renewalEventsThisMonth > 0
    ? Math.round((renewalEventsThisMonth / (expiredThisMonth + renewalEventsThisMonth)) * 1000) / 10
    : null;

  let expectedRenewalRevenue: number | null = 0;
  const planRows = await db.select({ key: subscriptionPlansTable.key, price: subscriptionPlansTable.price, isActive: subscriptionPlansTable.isActive })
    .from(subscriptionPlansTable).where(eq(subscriptionPlansTable.isActive, true));
  const priceByPlan = new Map(planRows.map((plan) => [plan.key, plan.price]));
  for (const item of expiring) {
    const price = priceByPlan.get(item.planKey);
    if (!Number.isFinite(price)) { expectedRenewalRevenue = null; break; }
    expectedRenewalRevenue += Number(price);
  }
  return {
    asOf: now.toISOString(), timezone: CAIRO_TIME_ZONE,
    expiringWithin7Days: expiring.length,
    expiredThisMonth,
    renewalEventsThisMonth,
    renewalRate,
    expectedRenewalRevenue,
    expectedRenewalRevenueBasis: expectedRenewalRevenue === null ? "unavailable" : "current_active_plan_prices",
    emailFailures: Number(failures[0]?.count || 0),
  };
}

export async function listSubscriptionEmailFailures(limit = 100): Promise<Array<{
  reminderId: string;
  subscriptionId: string;
  name: string;
  phone: string;
  planNameAr: string;
  reminderType: string;
  emailStatus: string;
  emailAttempts: number;
  emailLastError: string | null;
  createdAt: Date;
}>> {
  const rows = await db.select({
    reminderId: subscriptionRemindersSentTable.id,
    subscriptionId: subscriptionRemindersSentTable.subscriptionId,
    name: appUsersTable.name,
    phone: appUsersTable.phone,
    planNameAr: userSubscriptionsTable.planNameAr,
    reminderType: subscriptionRemindersSentTable.reminderType,
    emailStatus: subscriptionRemindersSentTable.emailStatus,
    emailAttempts: subscriptionRemindersSentTable.emailAttempts,
    emailLastError: subscriptionRemindersSentTable.emailLastError,
    createdAt: subscriptionRemindersSentTable.createdAt,
  }).from(subscriptionRemindersSentTable)
    .innerJoin(appUsersTable, eq(subscriptionRemindersSentTable.userId, appUsersTable.id))
    .innerJoin(userSubscriptionsTable, eq(subscriptionRemindersSentTable.subscriptionId, userSubscriptionsTable.id))
    .where(inArray(subscriptionRemindersSentTable.emailStatus, ["failed", "unavailable"]))
    .orderBy(desc(subscriptionRemindersSentTable.createdAt)).limit(Math.max(1, Math.min(limit, 200)));
  return rows;
}
