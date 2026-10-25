import crypto from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  appUsersTable,
  db,
  freeTrialMessageStepsTable,
  subscriptionLifecycleEventsTable,
  subscriptionPlansTable,
  subscriptionRemindersSentTable,
  trialClaimsTable,
  userSubscriptionsTable,
  type BroadcastAction,
  type BroadcastContent,
  type FreeTrialMessageStep,
  type SubscriptionReminderContent,
  type TrialMessageChannel,
} from "@workspace/db";
import { parseBroadcastMarkdown, safeBroadcastUrl } from "./broadcasts";
import { escapeHtml, isSmtpConfigured, sendMail } from "./mailer";
import { createMarketingUnsubscribeUrl } from "./marketing-email";
import { getEffectivePrice } from "./pricing";
import {
  DEFAULT_FREE_TRIAL_SETTINGS,
  readFreeTrialSettings,
  scopeAllows,
  type FreeTrialSettings,
  type TrialFeatureScope,
} from "./trial-settings";
import {
  addCairoCalendarDays,
  cairoCalendarDaysUntil,
  formatCairoDate,
} from "./subscription-time";
import {
  deliverLifecycleInApp,
  processLifecycleEmailOutbox,
  type LifecycleMailer,
} from "./subscription-lifecycle";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_TITLE = 140;
const MAX_BODY = 5_000;
const MAX_STEP_OFFSET = 90;
const TRIAL_PLAN_KEY = "free-vip-trial";
const TRIAL_PLAN_NAME = "تجربة VIP مجانية";
const TRIAL_MESSAGE_TYPES = ["offer", "greeting", "new_feature", "maintenance", "important"] as const;
const TRIAL_STEP_STATUSES = ["active", "paused", "archived"] as const;
const TRIAL_TIMINGS = ["after_start", "before_end", "at_end", "after_end"] as const;
const TRIAL_CHANNELS = ["in_app", "modal", "email"] as const;
const ALLOWED_VARIABLES = new Set(["name", "days_left", "end_date", "price", "old_price", "discount_percent", "coupon"]);

/** A deliberately conservative local list. It is an abuse-control signal,
 * not a claim that every disposable domain on the internet is detected. */
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "maildrop.cc", "guerrillamail.com", "guerrillamail.net",
  "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org",
  "yopmail.com", "throwawaymail.com", "getnada.com", "sharklasers.com",
  "dispostable.com", "fakeinbox.com", "trashmail.com", "mohmal.com",
]);

export type TrialStartReason =
  | "started"
  | "disabled"
  | "email_unverified"
  | "email_missing"
  | "email_disposable"
  | "already_claimed"
  | "already_active"
  | "already_paid"
  | "user_not_found";

export type TrialStartResult = {
  reason: TrialStartReason;
  subscriptionId?: string;
  cycleId?: string;
  startsAt?: Date;
  endsAt?: Date;
};

type TrialCandidate = {
  id: string;
  userId: number;
  planKey: string;
  status: string;
  cycleId: string;
  startsAt: Date;
  expiresAt: Date;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  trialEndedAt: Date | null;
  trialFeatureScope: string[] | "all" | null;
  trialAiDailyLimit: number | null;
  phone: string;
  name: string;
  email: string | null;
  marketingEmailOptIn: boolean;
  userStatus: string;
};

type TrialStepDraft = {
  timing: "after_start" | "before_end" | "at_end" | "after_end";
  offsetDays: number;
  channels: TrialMessageChannel[];
  titleTemplate: string;
  bodyTemplate: string;
  messageType: typeof TRIAL_MESSAGE_TYPES[number];
  actionLabel: string | null;
  actionPlanKey: string | null;
  emailMarketing: boolean;
  status: "active" | "paused";
};

export type PublicTrialMessage = {
  id: string;
  stepId: string;
  title: string;
  content: BroadcastContent;
  messageType: typeof TRIAL_MESSAGE_TYPES[number];
  action: BroadcastAction;
  channels: TrialMessageChannel[];
  generatedAt: string;
  variableSource: "current_server_price" | "not_requested" | "unavailable";
  openedAt: string | null;
  clickedAt: string | null;
  createdAt: string;
};

function hashId(prefix: string, value: string): string {
  return `${prefix}-${crypto.createHash("sha256").update(value).digest("hex").slice(0, 30)}`;
}

function eventId(cycleId: string, type: string): string {
  return hashId("subevent", `${cycleId}:${type}`);
}

function nonEmptyText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, max);
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))]
    : [];
}

function validTiming(value: unknown): value is TrialStepDraft["timing"] {
  return typeof value === "string" && (TRIAL_TIMINGS as readonly string[]).includes(value);
}

function validStatus(value: unknown): value is TrialStepDraft["status"] {
  return value === "active" || value === "paused";
}

function validMessageType(value: unknown): value is TrialStepDraft["messageType"] {
  return typeof value === "string" && (TRIAL_MESSAGE_TYPES as readonly string[]).includes(value);
}

function hasTemplateVariables(value: string): { ok: boolean; error?: string } {
  const source = String(value || "");
  const matches = [...source.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)];
  for (const match of matches) {
    if (!ALLOWED_VARIABLES.has(match[1]!)) return { ok: false, error: `المتغير {{${match[1]}}} غير مسموح.` };
  }
  /* A half-written moustache can accidentally promise a value that will not be
   * substituted. Reject it rather than silently shipping a broken message. */
  const stripped = source.replace(/\{\{\s*[^{}\s]+\s*\}\}/g, "");
  if (stripped.includes("{{") || stripped.includes("}}")) return { ok: false, error: "صيغة المتغير غير مكتملة." };
  if (/\{\{\s*coupon\s*\}\}/.test(source)) {
    return { ok: false, error: "متغير الكوبون غير متاح قبل ربط redemption فعلي بطلب الدفع." };
  }
  return { ok: true };
}

function parseStepDraft(raw: unknown): { value?: TrialStepDraft; error?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "بيانات الرسالة غير صالحة." };
  const input = raw as Record<string, unknown>;
  const timing = input.timing;
  const status = input.status ?? "active";
  const messageType = input.messageType ?? "important";
  if (!validTiming(timing) || !validStatus(status) || !validMessageType(messageType)) {
    return { error: "التوقيت أو الحالة أو نوع الرسالة غير صالح." };
  }
  const offsetDays = Number(input.offsetDays ?? 0);
  if (!Number.isInteger(offsetDays) || offsetDays < 0 || offsetDays > MAX_STEP_OFFSET) {
    return { error: `عدد الأيام يجب أن يكون بين 0 و${MAX_STEP_OFFSET}.` };
  }
  if (timing === "at_end" && offsetDays !== 0) return { error: "رسالة وقت الانتهاء يجب أن يكون تأخيرها صفرًا." };
  const channels = uniqueStrings(input.channels);
  if (!channels.length || channels.length > TRIAL_CHANNELS.length || channels.some((channel) => !(TRIAL_CHANNELS as readonly string[]).includes(channel))) {
    return { error: "اختر قناة واحدة أو أكثر من داخل التطبيق أو النافذة أو البريد." };
  }
  const titleTemplate = nonEmptyText(input.titleTemplate, MAX_TITLE);
  const bodyTemplate = String(input.bodyTemplate ?? "")
    .replace(/\u0000/g, "")
    /* Persist only the same markdown-safe source the renderer parses. */
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, MAX_BODY);
  if (titleTemplate.length < 2 || !parseBroadcastMarkdown(bodyTemplate)) {
    return { error: "أدخل عنوانًا ونصًا صالحين؛ لا يقبل HTML خامًا." };
  }
  const variables = hasTemplateVariables(`${titleTemplate}\n${bodyTemplate}`);
  if (!variables.ok) return { error: variables.error };
  const actionLabel = input.actionLabel === undefined || input.actionLabel === null || String(input.actionLabel).trim() === ""
    ? null : nonEmptyText(input.actionLabel, 40);
  const rawPlan = input.actionPlanKey === undefined || input.actionPlanKey === null ? "" : String(input.actionPlanKey).trim();
  const actionPlanKey = rawPlan ? rawPlan.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) : null;
  if (rawPlan && !actionPlanKey) return { error: "مفتاح باقة زر الاشتراك غير صالح." };
  if (input.couponCode !== undefined && String(input.couponCode || "").trim()) {
    return { error: "لا يمكن اختيار كوبون قبل تفعيل redemption حقيقي في طلبات الدفع." };
  }
  const emailMarketing = input.emailMarketing === true;
  if (emailMarketing && !channels.includes("email")) return { error: "التصنيف التسويقي يخص رسالة بريدية فقط." };
  return {
    value: {
      timing,
      offsetDays,
      channels: channels as TrialMessageChannel[],
      titleTemplate,
      bodyTemplate,
      messageType,
      actionLabel,
      actionPlanKey,
      emailMarketing,
      status,
    },
  };
}

export function canonicalTrialEmail(value: unknown): string | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!EMAIL_RE.test(raw)) return null;
  const at = raw.lastIndexOf("@");
  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  if (!local || !domain || local.length > 100 || domain.length > 253) return null;
  local = local.split("+", 1)[0]!;
  if (!local) return null;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local && domain ? `${local}@${domain}` : null;
}

export function isDisposableTrialEmail(canonicalEmail: string): boolean {
  const domain = canonicalEmail.split("@")[1] || "";
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  return /(?:^|[.-])(tempmail|temp-mail|mailinator|guerrillamail|throwaway|disposable)(?:[.-]|$)/i.test(domain);
}

function reviewSignal(value: string | undefined): string | null {
  const source = String(value || "").trim();
  const pepper = process.env["TRIAL_SIGNAL_SECRET"] || process.env["SESSION_SECRET"];
  if (!source || !pepper) return null;
  return crypto.createHmac("sha256", pepper).update(`trial-review-signal:${source.slice(0, 512)}`).digest("hex");
}

const DEFAULT_STEPS: Array<Omit<FreeTrialMessageStep, "createdAt" | "updatedAt" | "archivedAt" | "createdBy" | "updatedBy">> = [
  {
    id: "trial-step-welcome", timing: "after_start", offsetDays: 0, channels: ["in_app"],
    titleTemplate: "أهلًا {{name}} في تجربة VIP المجانية ✨",
    bodyTemplate: "بدأت تجربتك المجانية لمدة {{days_left}} يومًا. استكشف مزايا VIP، ولا توجد أي بيانات دفع أو خصم أو تجديد تلقائي.",
    messageType: "greeting", actionLabel: "عرض الباقات", actionPlanKey: null, couponCode: null,
    emailMarketing: false, status: "active", version: 1,
  },
  {
    id: "trial-step-before-end", timing: "before_end", offsetDays: 2, channels: ["in_app"],
    titleTemplate: "باقي {{days_left}} يوم على تجربة VIP",
    bodyTemplate: "تنتهي تجربتك يوم {{end_date}}. ستبقى بياناتك محفوظة عند العودة للخطة المجانية، ويمكنك اختيار باقة عندما تكون جاهزًا.",
    messageType: "important", actionLabel: "اختيار باقة", actionPlanKey: null, couponCode: null,
    emailMarketing: false, status: "active", version: 1,
  },
  {
    id: "trial-step-expiry", timing: "at_end", offsetDays: 0, channels: ["in_app", "modal", "email"],
    titleTemplate: "انتهت تجربتك المجانية",
    bodyTemplate: "انتهت تجربة VIP يوم {{end_date}} وعاد حسابك للخطة المجانية. بياناتك محفوظة، ويمكنك الاشتراك لاستعادة المزايا.",
    messageType: "important", actionLabel: "اشترك الآن", actionPlanKey: null, couponCode: null,
    emailMarketing: false, status: "active", version: 1,
  },
  {
    id: "trial-step-after-end-offer", timing: "after_end", offsetDays: 3, channels: ["in_app", "email"],
    titleTemplate: "مزايا VIP ما زالت بانتظارك",
    bodyTemplate: "إذا أردت العودة إلى مزايا VIP، راجع الباقات والأسعار الحالية من الخادم.",
    messageType: "offer", actionLabel: "عرض الباقات", actionPlanKey: null, couponCode: null,
    emailMarketing: true, status: "paused", version: 1,
  },
];

/** Safe to call repeatedly from API/scheduler; it creates only missing default IDs. */
export async function ensureFreeTrialDefaults(now = new Date()): Promise<void> {
  for (const step of DEFAULT_STEPS) {
    await db.insert(freeTrialMessageStepsTable).values({
      ...step,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
  }
}

export async function listFreeTrialMessageSteps(includeArchived = false): Promise<FreeTrialMessageStep[]> {
  await ensureFreeTrialDefaults();
  return db.select().from(freeTrialMessageStepsTable)
    .where(includeArchived ? undefined : or(eq(freeTrialMessageStepsTable.status, "active"), eq(freeTrialMessageStepsTable.status, "paused")))
    .orderBy(asc(freeTrialMessageStepsTable.createdAt));
}

async function assertActivePlanKey(key: string | null): Promise<boolean> {
  if (!key) return true;
  const [plan] = await db.select({ id: subscriptionPlansTable.id }).from(subscriptionPlansTable)
    .where(and(eq(subscriptionPlansTable.key, key), eq(subscriptionPlansTable.isActive, true))).limit(1);
  return Boolean(plan);
}

async function cancelQueuedStepDeliveries(stepId: string, now: Date): Promise<void> {
  await db.update(subscriptionRemindersSentTable).set({
    deliveryStatus: "cancelled",
    emailStatus: "cancelled",
    emailNextAttemptAt: null,
    cancelledAt: now,
    updatedAt: now,
  }).where(and(
    eq(subscriptionRemindersSentTable.trialMessageStepId, stepId),
    eq(subscriptionRemindersSentTable.deliveryStatus, "queued"),
  ));
}

export async function previewFreeTrialMessageStep(raw: unknown, now = new Date()): Promise<{ message?: { title: string; content: BroadcastContent; messageType: typeof TRIAL_MESSAGE_TYPES[number]; action: BroadcastAction; generatedAt: string; variableSource: "current_server_price" | "not_requested" | "unavailable" }; error?: string }> {
  const checked = parseStepDraft(raw);
  if (!checked.value) return { error: checked.error };
  if (!(await assertActivePlanKey(checked.value.actionPlanKey))) return { error: "باقة زر الاشتراك غير مفعّلة أو غير موجودة." };
  const step = {
    id: "trial-step-preview",
    ...checked.value,
    couponCode: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  } as FreeTrialMessageStep;
  const candidate: TrialCandidate = {
    id: "trial-preview", userId: 0, planKey: TRIAL_PLAN_KEY, status: "active", cycleId: "trial-preview",
    startsAt: now, expiresAt: addCairoCalendarDays(now, DEFAULT_FREE_TRIAL_SETTINGS.durationDays),
    trialStartedAt: now, trialEndsAt: addCairoCalendarDays(now, DEFAULT_FREE_TRIAL_SETTINGS.durationDays), trialEndedAt: null,
    trialFeatureScope: "all", trialAiDailyLimit: DEFAULT_FREE_TRIAL_SETTINGS.aiDailyLimit,
    phone: "", name: "مستخدم تجريبي", email: null, marketingEmailOptIn: false, userStatus: "active",
  };
  const rendered = await buildTrialReminderContent(candidate, step, now);
  const snapshot = rendered.content.trial!;
  return { message: { title: rendered.content.title, content: snapshot.content, messageType: snapshot.messageType, action: snapshot.action, generatedAt: snapshot.generatedAt, variableSource: snapshot.variableSource } };
}

export async function createFreeTrialMessageStep(raw: unknown, employeeId: number | null, now = new Date()): Promise<{ step?: FreeTrialMessageStep; error?: string }> {
  const checked = parseStepDraft(raw);
  if (!checked.value) return { error: checked.error };
  if (!(await assertActivePlanKey(checked.value.actionPlanKey))) return { error: "باقة زر الاشتراك غير مفعّلة أو غير موجودة." };
  const [step] = await db.insert(freeTrialMessageStepsTable).values({
    id: `trial-step-${crypto.randomUUID()}`,
    ...checked.value,
    couponCode: null,
    version: 1,
    createdBy: employeeId && employeeId > 0 ? employeeId : null,
    updatedBy: employeeId && employeeId > 0 ? employeeId : null,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return step ? { step } : { error: "تعذر إنشاء الرسالة." };
}

export async function updateFreeTrialMessageStep(id: string, raw: unknown, employeeId: number | null, now = new Date()): Promise<{ step?: FreeTrialMessageStep; error?: string }> {
  const checked = parseStepDraft(raw);
  if (!checked.value) return { error: checked.error };
  if (!(await assertActivePlanKey(checked.value.actionPlanKey))) return { error: "باقة زر الاشتراك غير مفعّلة أو غير موجودة." };
  const [prior] = await db.select({ id: freeTrialMessageStepsTable.id, status: freeTrialMessageStepsTable.status, version: freeTrialMessageStepsTable.version })
    .from(freeTrialMessageStepsTable).where(eq(freeTrialMessageStepsTable.id, id)).limit(1);
  if (!prior || prior.status === "archived") return { error: "الرسالة غير موجودة أو مؤرشفة." };
  /* A versioned reminder type makes edits future-only. Queued old snapshots
   * are cancelled, while already-delivered history remains immutable. */
  await cancelQueuedStepDeliveries(id, now);
  const [step] = await db.update(freeTrialMessageStepsTable).set({
    ...checked.value,
    couponCode: null,
    version: prior.version + 1,
    updatedBy: employeeId && employeeId > 0 ? employeeId : null,
    updatedAt: now,
  }).where(eq(freeTrialMessageStepsTable.id, id)).returning();
  return step ? { step } : { error: "تعذر تحديث الرسالة." };
}

export async function archiveFreeTrialMessageStep(id: string, employeeId: number | null, now = new Date()): Promise<FreeTrialMessageStep | null> {
  const [prior] = await db.select({ id: freeTrialMessageStepsTable.id, status: freeTrialMessageStepsTable.status })
    .from(freeTrialMessageStepsTable).where(eq(freeTrialMessageStepsTable.id, id)).limit(1);
  if (!prior || prior.status === "archived") return null;
  await cancelQueuedStepDeliveries(id, now);
  const [step] = await db.update(freeTrialMessageStepsTable).set({
    status: "archived",
    archivedAt: now,
    updatedBy: employeeId && employeeId > 0 ? employeeId : null,
    updatedAt: now,
  }).where(eq(freeTrialMessageStepsTable.id, id)).returning();
  return step || null;
}

function featureScopeLabels(scope: TrialFeatureScope): string[] {
  if (scope === "all") return ["كل مزايا VIP"];
  const labels: Record<string, string> = {
    portfolio: "المحفظة",
    price_alerts: "تنبيهات الأسعار",
    calculators: "الحاسبات",
    ai: "مساعد AI",
    opportunities: "الفرص",
    indicators: "المؤشرات",
  };
  return scope.map((key) => labels[key] || key);
}

function trialCycleId(userId: number, now: Date): string {
  return `trialcycle-${userId}-${now.getTime().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}

function trialSubscriptionId(userId: number): string {
  return `trial-sub-${userId}`;
}

export async function startFreeTrial(input: {
  userId: number;
  now?: Date;
  mode?: "self" | "auto" | "admin";
  durationDays?: number;
  actorEmployeeId?: number | null;
  ip?: string;
  device?: string;
  mailer?: LifecycleMailer;
}): Promise<TrialStartResult> {
  const now = input.now ? new Date(input.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid trial clock");
  const mode = input.mode || "self";
  const settings = await readFreeTrialSettings();
  if (mode !== "admin" && !settings.enabled) return { reason: "disabled" };
  const requestedDays = input.durationDays === undefined ? settings.durationDays : Number(input.durationDays);
  const durationDays = Number.isInteger(requestedDays) && requestedDays >= 1 && requestedDays <= 31 ? requestedDays : settings.durationDays;
  const scope = settings.featureScope;
  const aiDailyLimit = settings.aiDailyLimit;
  const result = await db.transaction(async (tx) => {
    const [user] = await tx.select({
      id: appUsersTable.id,
      email: appUsersTable.email,
      emailVerifiedAt: appUsersTable.emailVerifiedAt,
      status: appUsersTable.status,
    }).from(appUsersTable).where(eq(appUsersTable.id, input.userId)).for("update").limit(1);
    if (!user || user.status !== "active") return { reason: "user_not_found" } as TrialStartResult;
    if (mode !== "admin" && !user.emailVerifiedAt) return { reason: "email_unverified" } as TrialStartResult;
    const canonicalEmail = canonicalTrialEmail(user.email);
    if (!canonicalEmail) return { reason: "email_missing" } as TrialStartResult;
    if (isDisposableTrialEmail(canonicalEmail)) return { reason: "email_disposable" } as TrialStartResult;

    const [current] = await tx.select().from(userSubscriptionsTable)
      .where(eq(userSubscriptionsTable.userId, user.id)).for("update").limit(1);
    if (current?.subscriptionType === "paid" && current.status === "active" && current.expiresAt.getTime() > now.getTime()) {
      return { reason: "already_paid" } as TrialStartResult;
    }
    if (current?.subscriptionType === "trial" && current.status === "active" && current.expiresAt.getTime() > now.getTime()) {
      return { reason: "already_active", subscriptionId: current.id, cycleId: current.cycleId, startsAt: current.startsAt, endsAt: current.expiresAt } as TrialStartResult;
    }
    const [claim] = await tx.select().from(trialClaimsTable).where(eq(trialClaimsTable.userId, user.id)).limit(1);
    if (claim && mode !== "admin") return { reason: "already_claimed" } as TrialStartResult;
    const [canonicalClaim] = await tx.select({ id: trialClaimsTable.id }).from(trialClaimsTable)
      .where(eq(trialClaimsTable.canonicalEmail, canonicalEmail)).limit(1);
    if (canonicalClaim && !claim && mode !== "admin") return { reason: "already_claimed" } as TrialStartResult;

    const subscriptionId = current?.id || trialSubscriptionId(user.id);
    const cycleId = trialCycleId(user.id, now);
    const endsAt = addCairoCalendarDays(now, durationDays);
    const source = mode === "admin" ? "admin_trial_grant" : mode === "auto" ? "email_verified_trial" : "free_trial";
    await tx.insert(userSubscriptionsTable).values({
      id: subscriptionId,
      userId: user.id,
      planKey: TRIAL_PLAN_KEY,
      planNameAr: TRIAL_PLAN_NAME,
      planDurationMonths: 0,
      planFeatures: featureScopeLabels(scope),
      subscriptionType: "trial",
      trialFeatureScope: scope,
      trialAiDailyLimit: aiDailyLimit,
      status: "active",
      cycleId,
      startsAt: now,
      expiresAt: endsAt,
      graceEndsAt: null,
      paymentRequestId: null,
      source,
      trialStartedAt: now,
      trialEndsAt: endsAt,
      trialEndedAt: null,
      trialConvertedAt: null,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: userSubscriptionsTable.userId,
      set: {
        planKey: TRIAL_PLAN_KEY,
        planNameAr: TRIAL_PLAN_NAME,
        planDurationMonths: 0,
        planFeatures: featureScopeLabels(scope),
        subscriptionType: "trial",
        trialFeatureScope: scope,
        trialAiDailyLimit: aiDailyLimit,
        status: "active",
        cycleId,
        startsAt: now,
        expiresAt: endsAt,
        graceEndsAt: null,
        paymentRequestId: null,
        source,
        trialStartedAt: now,
        trialEndsAt: endsAt,
        trialEndedAt: null,
        trialConvertedAt: null,
        cancelledAt: null,
        updatedAt: now,
      },
    });
    if (!claim && !canonicalClaim) {
      await tx.insert(trialClaimsTable).values({
        id: `trial-claim-${crypto.randomUUID()}`,
        userId: user.id,
        canonicalEmail,
        trialSubscriptionId: subscriptionId,
        startedAt: now,
        ipSignalHash: reviewSignal(input.ip),
        deviceSignalHash: reviewSignal(input.device),
        manualOverride: mode === "admin",
        createdAt: now,
        updatedAt: now,
      });
    } else if (mode === "admin") {
      await tx.update(trialClaimsTable).set({
        manualOverride: true,
        ipSignalHash: reviewSignal(input.ip) || claim?.ipSignalHash || null,
        deviceSignalHash: reviewSignal(input.device) || claim?.deviceSignalHash || null,
        updatedAt: now,
      }).where(eq(trialClaimsTable.userId, user.id));
    }
    await tx.update(appUsersTable).set({ plan: "vip", vipExpiresAt: endsAt, updatedAt: now }).where(eq(appUsersTable.id, user.id));
    await tx.insert(subscriptionLifecycleEventsTable).values({
      id: eventId(cycleId, mode === "admin" ? "trial_granted" : "trial_started"),
      userId: user.id,
      subscriptionId,
      subscriptionCycleId: cycleId,
      eventType: mode === "admin" ? "trial_granted" : "trial_started",
      planKey: TRIAL_PLAN_KEY,
      occurredAt: now,
      createdAt: now,
    }).onConflictDoNothing();
    return { reason: "started", subscriptionId, cycleId, startsAt: now, endsAt } as TrialStartResult;
  });

  /* Welcome delivery is attempted immediately through the same durable
   * lifecycle/outbox path. Failure leaves the reservation retryable; it never
   * changes the entitlement result. */
  if (result.reason === "started" && result.subscriptionId) {
    await runFreeTrialLifecycle({ now, subscriptionId: result.subscriptionId, mailer: input.mailer });
  }
  return result;
}

async function trialCandidates(subscriptionId?: string): Promise<TrialCandidate[]> {
  const rows = await db.select({
    id: userSubscriptionsTable.id,
    userId: userSubscriptionsTable.userId,
    planKey: userSubscriptionsTable.planKey,
    status: userSubscriptionsTable.status,
    cycleId: userSubscriptionsTable.cycleId,
    startsAt: userSubscriptionsTable.startsAt,
    expiresAt: userSubscriptionsTable.expiresAt,
    trialStartedAt: userSubscriptionsTable.trialStartedAt,
    trialEndsAt: userSubscriptionsTable.trialEndsAt,
    trialEndedAt: userSubscriptionsTable.trialEndedAt,
    trialFeatureScope: userSubscriptionsTable.trialFeatureScope,
    trialAiDailyLimit: userSubscriptionsTable.trialAiDailyLimit,
    phone: appUsersTable.phone,
    name: appUsersTable.name,
    email: appUsersTable.email,
    marketingEmailOptIn: appUsersTable.marketingEmailOptIn,
    userStatus: appUsersTable.status,
  }).from(userSubscriptionsTable)
    .innerJoin(appUsersTable, eq(userSubscriptionsTable.userId, appUsersTable.id))
    .where(and(
      eq(userSubscriptionsTable.subscriptionType, "trial"),
      inArray(userSubscriptionsTable.status, ["active", "expired"]),
      eq(appUsersTable.status, "active"),
      subscriptionId ? eq(userSubscriptionsTable.id, subscriptionId) : undefined,
    ));
  return rows as TrialCandidate[];
}

function trialStepReminderType(step: Pick<FreeTrialMessageStep, "id" | "version">): string {
  return `trial:${step.id}:v${step.version}`;
}

function trialReminderId(cycleId: string, reminderType: string): string {
  return hashId("trialrem", `${cycleId}:${reminderType}`);
}

function templateValues(input: {
  candidate: TrialCandidate;
  now: Date;
  effective: { price: number; oldPrice: number | null; discountPercent: number | null } | null;
}): Record<string, string> {
  const end = input.candidate.trialEndsAt || input.candidate.expiresAt;
  const daysLeft = Math.max(0, cairoCalendarDaysUntil(end, input.now));
  const egp = (amount: number) => `${Number(amount).toLocaleString("ar-EG")} ج`;
  return {
    name: nonEmptyText(input.candidate.name, 80) || "عضو EgyTrend",
    days_left: String(daysLeft),
    end_date: formatCairoDate(end),
    price: input.effective && input.effective.price > 0 ? egp(input.effective.price) : "غير متاح حاليًا",
    old_price: input.effective?.oldPrice && input.effective.oldPrice > input.effective.price ? egp(input.effective.oldPrice) : "غير متاح حاليًا",
    discount_percent: input.effective?.discountPercent && input.effective.discountPercent > 0 ? `${Number(input.effective.discountPercent).toLocaleString("ar-EG")}%` : "غير متاح حاليًا",
    coupon: "غير متاح حاليًا",
  };
}

function interpolate(value: string, values: Record<string, string>): string {
  return String(value || "").replace(/\{\{\s*(name|days_left|end_date|price|old_price|discount_percent|coupon)\s*\}\}/g, (_all, key: string) => values[key] || "غير متاح حاليًا");
}

function astPlainText(content: BroadcastContent): string {
  const blocks: string[] = [];
  for (const block of content.blocks) {
    if (block.type === "paragraph" && Array.isArray(block.inlines)) blocks.push(block.inlines.map((item) => item.text).join(""));
    if ((block.type === "bullet_list" || block.type === "ordered_list") && Array.isArray(block.items)) {
      blocks.push(block.items.map((line) => `• ${line.map((item) => item.text).join("")}`).join("\n"));
    }
  }
  return blocks.join("\n").replace(/\s{3,}/g, " ").trim().slice(0, MAX_BODY);
}

function configuredBaseUrl(): string | null {
  const raw = String(process.env["APP_BASE_URL"] || "").trim().replace(/\/+$/, "");
  if (!raw) return process.env.NODE_ENV === "production" ? null : "http://localhost:3000";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || (process.env.NODE_ENV !== "production" && parsed.protocol === "http:") ? parsed.toString().replace(/\/$/, "") : null;
  } catch { return null; }
}

async function selectedActionPlan(step: FreeTrialMessageStep): Promise<typeof subscriptionPlansTable.$inferSelect | null> {
  if (step.actionPlanKey) {
    const [plan] = await db.select().from(subscriptionPlansTable)
      .where(and(eq(subscriptionPlansTable.key, step.actionPlanKey), eq(subscriptionPlansTable.isActive, true))).limit(1);
    return plan || null;
  }
  const [plan] = await db.select().from(subscriptionPlansTable)
    .where(eq(subscriptionPlansTable.isActive, true)).orderBy(asc(subscriptionPlansTable.price)).limit(1);
  return plan || null;
}

async function buildTrialReminderContent(candidate: TrialCandidate, step: FreeTrialMessageStep, now: Date): Promise<{
  content: SubscriptionReminderContent;
  emailReady: boolean;
}> {
  const needsPrice = /\{\{\s*(price|old_price|discount_percent)\s*\}\}/.test(`${step.titleTemplate}\n${step.bodyTemplate}`);
  const plan = await selectedActionPlan(step);
  const effective = plan ? await getEffectivePrice({ sub: candidate.userId, phone: candidate.phone }, plan, now) : null;
  const values = templateValues({ candidate, now, effective });
  const title = interpolate(step.titleTemplate, values);
  const bodySource = interpolate(step.bodyTemplate, values);
  const content = parseBroadcastMarkdown(bodySource) || { version: 1 as const, blocks: [{ type: "paragraph" as const, inlines: [{ text: "غير متاح حاليًا" }] }] };
  const action: BroadcastAction = step.actionLabel && plan
    ? { kind: "link", label: step.actionLabel, url: `/vip?plan=${encodeURIComponent(plan.key)}&renew=1` }
    : { kind: "none" };
  const safeUrl = action.kind === "link" ? safeBroadcastUrl(action.url) : null;
  const safeAction: BroadcastAction = action.kind === "link" && action.label && safeUrl
    ? { kind: "link", label: action.label, url: safeUrl }
    : { kind: "none" };
  const actionUrl = safeAction.kind === "link" && safeAction.url ? safeAction.url : "/vip";
  const actionLabel = safeAction.kind === "link" && safeAction.label ? safeAction.label : "عرض الباقات";
  const plainBody = astPlainText(content);
  const base = configuredBaseUrl();
  const absoluteAction = base ? `${base}${actionUrl}` : actionUrl;
  const marketing = step.emailMarketing;
  const unsubscribe = marketing ? createMarketingUnsubscribeUrl(candidate.userId) : null;
  const emailReady = !marketing || Boolean(unsubscribe);
  const footer = marketing
    ? `<p style="font-size:12px;color:#6b7280;line-height:1.7">هذه رسالة تسويقية لأنك وافقت على الرسائل التسويقية. <a href="${escapeHtml(unsubscribe || "#")}">إلغاء الاشتراك</a></p>`
    : `<p style="font-size:12px;color:#6b7280;line-height:1.7">هذه رسالة خدمية عن تجربة VIP الخاصة بك. لا تُحذف بياناتك عند انتهاء التجربة.</p>`;
  const emailHtml = `<!doctype html><html dir="rtl" lang="ar"><body style="margin:0;background:#f4f6f5;padding:22px;font-family:Tahoma,Arial,sans-serif;color:#172033"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px"><h2 style="margin:0 0 14px;color:#047857">${escapeHtml(title)} — EgyTrend</h2><p style="font-size:15px;line-height:1.9;white-space:pre-line">${escapeHtml(plainBody)}</p>${safeAction.kind === "link" ? `<p style="text-align:center;margin:24px 0"><a href="${escapeHtml(absoluteAction)}" style="display:inline-block;background:#059669;color:#fff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:10px">${escapeHtml(actionLabel)}</a></p>` : ""}${footer}</div></body></html>`;
  return {
    emailReady,
    content: {
      title,
      body: plainBody,
      actionUrl,
      actionLabel,
      emailSubject: `EgyTrend — ${title}`.slice(0, 180),
      emailHtml,
      transactional: !marketing,
      trial: {
        kind: "free_trial",
        stepId: step.id,
        stepVersion: step.version,
        channels: step.channels,
        messageType: step.messageType as typeof TRIAL_MESSAGE_TYPES[number],
        content,
        action: safeAction,
        variableSource: needsPrice ? (effective ? "current_server_price" : "unavailable") : "not_requested",
        generatedAt: now.toISOString(),
      },
    },
  };
}

function stepIsDue(step: FreeTrialMessageStep, candidate: TrialCandidate, now: Date): boolean {
  const startsAt = candidate.trialStartedAt || candidate.startsAt;
  const endsAt = candidate.trialEndsAt || candidate.expiresAt;
  if (step.timing === "after_start") return candidate.status === "active" && now.getTime() >= startsAt.getTime()
    && cairoCalendarDaysUntil(now, startsAt) >= step.offsetDays && now.getTime() < endsAt.getTime();
  if (step.timing === "before_end") {
    const days = cairoCalendarDaysUntil(endsAt, now);
    return candidate.status === "active" && now.getTime() < endsAt.getTime() && days > 0 && days <= step.offsetDays;
  }
  if (step.timing === "at_end") return now.getTime() >= endsAt.getTime();
  const dueAt = addCairoCalendarDays(endsAt, step.offsetDays);
  return now.getTime() >= dueAt.getTime();
}

async function reserveTrialStep(candidate: TrialCandidate, step: FreeTrialMessageStep, now: Date): Promise<boolean> {
  const rendered = await buildTrialReminderContent(candidate, step, now);
  const hasEmail = step.channels.includes("email");
  const reminderType = trialStepReminderType(step);
  const inserted = await db.insert(subscriptionRemindersSentTable).values({
    id: trialReminderId(candidate.cycleId, reminderType),
    subscriptionId: candidate.id,
    subscriptionCycleId: candidate.cycleId,
    userId: candidate.userId,
    reminderType,
    reminderClass: step.emailMarketing ? "marketing" : "transactional",
    trialMessageStepId: step.id,
    targetEndsAt: candidate.trialEndsAt || candidate.expiresAt,
    deliveryStatus: "queued",
    content: rendered.content,
    emailStatus: !hasEmail ? "suppressed" : rendered.emailReady ? "pending" : "unavailable",
    emailNextAttemptAt: hasEmail && rendered.emailReady ? now : null,
    emailLastError: hasEmail && !rendered.emailReady ? "unsubscribe_url_not_configured" : null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning({ id: subscriptionRemindersSentTable.id });
  return inserted.length > 0;
}

async function expireTrialCandidate(candidate: TrialCandidate, now: Date, dryRun: boolean): Promise<boolean> {
  if (candidate.status !== "active" || candidate.expiresAt.getTime() > now.getTime()) return false;
  if (dryRun) return true;
  const updated = await db.transaction(async (tx) => {
    const changed = await tx.update(userSubscriptionsTable).set({
      status: "expired",
      trialEndedAt: candidate.expiresAt,
      updatedAt: now,
    }).where(and(
      eq(userSubscriptionsTable.id, candidate.id),
      eq(userSubscriptionsTable.subscriptionType, "trial"),
      eq(userSubscriptionsTable.status, "active"),
    )).returning({ id: userSubscriptionsTable.id });
    if (!changed.length) return false;
    await tx.update(appUsersTable).set({ plan: "free", vipExpiresAt: candidate.expiresAt, updatedAt: now })
      .where(eq(appUsersTable.id, candidate.userId));
    await tx.insert(subscriptionLifecycleEventsTable).values({
      id: eventId(candidate.cycleId, "trial_expired"),
      userId: candidate.userId,
      subscriptionId: candidate.id,
      subscriptionCycleId: candidate.cycleId,
      eventType: "trial_expired",
      planKey: TRIAL_PLAN_KEY,
      occurredAt: now,
      createdAt: now,
    }).onConflictDoNothing();
    return true;
  });
  return updated;
}

export type FreeTrialLifecycleResult = {
  now: string;
  inspected: number;
  expired: number;
  queued: number;
  inAppDelivered: number;
  emailSent: number;
  emailUnavailable: number;
  emailSuppressed: number;
};

/**
 * Trial branch of the existing lifecycle worker. It uses reminders_sent's
 * cycle/type uniqueness as its durable idempotency boundary, then uses the
 * same in-app/email outbox handlers as paid subscription reminders.
 */
export async function runFreeTrialLifecycle(input: {
  now?: Date;
  subscriptionId?: string;
  dryRun?: boolean;
  mailer?: LifecycleMailer;
} = {}): Promise<FreeTrialLifecycleResult> {
  const now = input.now ? new Date(input.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid trial clock");
  const dryRun = input.dryRun === true;
  await ensureFreeTrialDefaults(now);
  const candidates = await trialCandidates(input.subscriptionId);
  let expired = 0;
  for (const candidate of candidates) {
    if (await expireTrialCandidate(candidate, now, dryRun)) {
      expired += 1;
      candidate.status = "expired";
      candidate.trialEndedAt = candidate.expiresAt;
    }
  }
  const steps = (await listFreeTrialMessageSteps(false)).filter((step) => step.status === "active");
  let queued = 0;
  if (!dryRun) {
    for (const candidate of candidates) {
      /* A paid conversion overwrites this projection, so it cannot appear in
       * candidates and sequence messages stop without a client-side flag. */
      for (const step of steps) {
        if (!stepIsDue(step, candidate, now)) continue;
        if (await reserveTrialStep(candidate, step, now)) queued += 1;
      }
    }
  }
  if (dryRun) return { now: now.toISOString(), inspected: candidates.length, expired, queued: 0, inAppDelivered: 0, emailSent: 0, emailUnavailable: 0, emailSuppressed: 0 };
  const cycles = candidates.map((candidate) => candidate.cycleId);
  const inAppDelivered = cycles.length ? await deliverLifecycleInApp(now, cycles) : 0;
  const email = cycles.length
    ? await processLifecycleEmailOutbox(now, input.mailer || sendMail, input.mailer ? true : isSmtpConfigured(), undefined, cycles)
    : { sent: 0, retrying: 0, failed: 0, unavailable: 0, suppressed: 0 };
  return {
    now: now.toISOString(), inspected: candidates.length, expired, queued, inAppDelivered,
    emailSent: email.sent, emailUnavailable: email.unavailable, emailSuppressed: email.suppressed,
  };
}

export async function freeTrialAccountStatus(userId: number, now = new Date()): Promise<{
  settings: Pick<FreeTrialSettings, "enabled" | "durationDays" | "startMode">;
  emailVerified: boolean;
  active: boolean;
  status: string | null;
  startsAt: string | null;
  endsAt: string | null;
  endedAt: string | null;
  daysLeft: number | null;
  featureScope: string[] | "all" | null;
  canStart: boolean;
  reason: Exclude<TrialStartReason, "started"> | null;
}> {
  const [settings, user, subscription, claim] = await Promise.all([
    readFreeTrialSettings(),
    db.select({ email: appUsersTable.email, emailVerifiedAt: appUsersTable.emailVerifiedAt, status: appUsersTable.status })
      .from(appUsersTable).where(eq(appUsersTable.id, userId)).limit(1).then((rows) => rows[0]),
    db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, userId)).limit(1).then((rows) => rows[0]),
    db.select({ id: trialClaimsTable.id }).from(trialClaimsTable).where(eq(trialClaimsTable.userId, userId)).limit(1).then((rows) => rows[0]),
  ]);
  const isActiveTrial = Boolean(subscription && (
    (subscription.subscriptionType === "trial" && subscription.status === "active" && subscription.expiresAt.getTime() > now.getTime())
    || (subscription.subscriptionType === "paid" && subscription.startsAt.getTime() > now.getTime()
      && !!subscription.trialEndsAt && subscription.trialEndsAt.getTime() > now.getTime()
      && !!subscription.trialConvertedAt)
  ));
  const paidActive = subscription?.subscriptionType === "paid" && subscription.status === "active" && subscription.expiresAt.getTime() > now.getTime();
  const canonical = canonicalTrialEmail(user?.email);
  let reason: Exclude<TrialStartReason, "started"> | null = null;
  if (!settings.enabled) reason = "disabled";
  else if (!user || user.status !== "active") reason = "user_not_found";
  else if (!user.emailVerifiedAt) reason = "email_unverified";
  else if (!canonical) reason = "email_missing";
  else if (isDisposableTrialEmail(canonical)) reason = "email_disposable";
  else if (paidActive) reason = "already_paid";
  else if (isActiveTrial) reason = "already_active";
  else if (claim) reason = "already_claimed";
  const endsAt = subscription?.subscriptionType === "trial" || isActiveTrial ? (subscription?.trialEndsAt || subscription?.expiresAt || null) : subscription?.trialEndsAt || null;
  return {
    settings: { enabled: settings.enabled, durationDays: settings.durationDays, startMode: settings.startMode },
    emailVerified: Boolean(user?.emailVerifiedAt),
    active: isActiveTrial,
    status: subscription?.subscriptionType === "trial" ? subscription.status : (subscription?.trialEndedAt ? "converted" : null),
    startsAt: subscription?.trialStartedAt?.toISOString() || null,
    endsAt: endsAt?.toISOString() || null,
    endedAt: subscription?.trialEndedAt?.toISOString() || null,
    daysLeft: isActiveTrial && endsAt ? Math.max(0, cairoCalendarDaysUntil(endsAt, now)) : null,
    featureScope: (subscription?.subscriptionType === "trial" || isActiveTrial) && subscription
      ? (subscription.trialFeatureScope === "all" || Array.isArray(subscription.trialFeatureScope) ? subscription.trialFeatureScope : "all")
      : null,
    canStart: reason === null,
    reason,
  };
}

export async function listFreeTrialMessages(userId: number, now = new Date()): Promise<PublicTrialMessage[]> {
  const rows = await db.select({ reminder: subscriptionRemindersSentTable })
    .from(subscriptionRemindersSentTable)
    .where(and(
      eq(subscriptionRemindersSentTable.userId, userId),
      isNotNull(subscriptionRemindersSentTable.trialMessageStepId),
      eq(subscriptionRemindersSentTable.deliveryStatus, "delivered"),
    )).orderBy(desc(subscriptionRemindersSentTable.createdAt)).limit(30);
  return rows.flatMap(({ reminder }) => {
    const snapshot = reminder.content?.trial;
    if (!snapshot || snapshot.kind !== "free_trial") return [];
    const channels = uniqueStrings(snapshot.channels).filter((channel): channel is TrialMessageChannel => (TRIAL_CHANNELS as readonly string[]).includes(channel));
    const action = snapshot.action?.kind === "link" && safeBroadcastUrl(snapshot.action.url)
      ? { kind: "link" as const, label: nonEmptyText(snapshot.action.label, 40), url: safeBroadcastUrl(snapshot.action.url)! }
      : { kind: "none" as const };
    return [{
      id: reminder.id,
      stepId: snapshot.stepId,
      title: nonEmptyText(reminder.content.title, MAX_TITLE) || "رسالة تجربة VIP",
      content: snapshot.content,
      messageType: validMessageType(snapshot.messageType) ? snapshot.messageType : "important",
      action,
      channels,
      generatedAt: snapshot.generatedAt,
      variableSource: snapshot.variableSource,
      openedAt: reminder.openedAt?.toISOString() || null,
      clickedAt: reminder.clickedAt?.toISOString() || null,
      createdAt: reminder.createdAt.toISOString(),
    }];
  });
}

export async function recordFreeTrialMessageEvent(userId: number, reminderId: string, event: "open" | "cta_click", now = new Date()): Promise<boolean> {
  if (!/^trialrem-[a-f0-9]{30}$/.test(reminderId)) return false;
  const set = event === "open"
    ? { openedAt: now, updatedAt: now }
    : { openedAt: now, clickedAt: now, updatedAt: now };
  const predicate = event === "open" ? isNull(subscriptionRemindersSentTable.openedAt) : isNull(subscriptionRemindersSentTable.clickedAt);
  const updated = await db.update(subscriptionRemindersSentTable).set(set)
    .where(and(
      eq(subscriptionRemindersSentTable.id, reminderId),
      eq(subscriptionRemindersSentTable.userId, userId),
      isNotNull(subscriptionRemindersSentTable.trialMessageStepId),
      predicate,
    )).returning({ id: subscriptionRemindersSentTable.id });
  return Boolean(updated.length);
}

export type AdminTrialUser = {
  userId: number;
  name: string;
  phone: string;
  email: string | null;
  emailVerified: boolean;
  subscriptionId: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  daysLeft: number;
  featureScope: string[] | "all" | null;
};

export async function listAdminFreeTrialUsers(now = new Date()): Promise<AdminTrialUser[]> {
  const rows = await db.select({
    userId: appUsersTable.id,
    name: appUsersTable.name,
    phone: appUsersTable.phone,
    email: appUsersTable.email,
    emailVerifiedAt: appUsersTable.emailVerifiedAt,
    subscriptionId: userSubscriptionsTable.id,
    status: userSubscriptionsTable.status,
    startsAt: userSubscriptionsTable.trialStartedAt,
    endsAt: userSubscriptionsTable.trialEndsAt,
    expiresAt: userSubscriptionsTable.expiresAt,
    featureScope: userSubscriptionsTable.trialFeatureScope,
  }).from(userSubscriptionsTable).innerJoin(appUsersTable, eq(userSubscriptionsTable.userId, appUsersTable.id))
    .where(and(eq(userSubscriptionsTable.subscriptionType, "trial"), eq(userSubscriptionsTable.status, "active")))
    .orderBy(asc(userSubscriptionsTable.expiresAt)).limit(1000);
  return rows.map((row) => ({
    userId: row.userId,
    name: row.name,
    phone: row.phone,
    email: row.email,
    emailVerified: Boolean(row.emailVerifiedAt),
    subscriptionId: row.subscriptionId,
    status: row.status,
    startsAt: row.startsAt || row.expiresAt,
    endsAt: row.endsAt || row.expiresAt,
    daysLeft: Math.max(0, cairoCalendarDaysUntil(row.endsAt || row.expiresAt, now)),
    featureScope: row.featureScope === "all" || Array.isArray(row.featureScope) ? row.featureScope : "all",
  }));
}

export async function extendFreeTrial(userId: number, days: number, now = new Date()): Promise<{ status: "extended" | "not_found" | "not_active"; endsAt?: Date }> {
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error("Trial extension must be 1–31 days");
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, userId)).for("update").limit(1);
    if (!row) return { status: "not_found" as const };
    if (row.subscriptionType !== "trial" || row.status !== "active" || row.expiresAt.getTime() <= now.getTime()) return { status: "not_active" as const };
    const endsAt = addCairoCalendarDays(row.expiresAt, days);
    await tx.update(userSubscriptionsTable).set({ expiresAt: endsAt, trialEndsAt: endsAt, updatedAt: now })
      .where(eq(userSubscriptionsTable.id, row.id));
    await tx.update(appUsersTable).set({ vipExpiresAt: endsAt, updatedAt: now }).where(eq(appUsersTable.id, userId));
    await tx.insert(subscriptionLifecycleEventsTable).values({
      id: eventId(row.cycleId, "trial_extended"), userId, subscriptionId: row.id, subscriptionCycleId: row.cycleId,
      eventType: "trial_extended", planKey: TRIAL_PLAN_KEY, occurredAt: now, createdAt: now,
    }).onConflictDoNothing();
    return { status: "extended" as const, endsAt };
  });
}

export async function endFreeTrialNow(userId: number, now = new Date(), mailer?: LifecycleMailer): Promise<{ status: "ended" | "not_found" | "not_active" }> {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, userId)).for("update").limit(1);
    if (!row) return { status: "not_found" as const };
    if (row.subscriptionType !== "trial" || row.status !== "active") return { status: "not_active" as const };
    await tx.update(userSubscriptionsTable).set({
      status: "expired", expiresAt: now, trialEndsAt: now, trialEndedAt: now, updatedAt: now,
    }).where(eq(userSubscriptionsTable.id, row.id));
    await tx.update(appUsersTable).set({ plan: "free", vipExpiresAt: now, updatedAt: now }).where(eq(appUsersTable.id, userId));
    await tx.insert(subscriptionLifecycleEventsTable).values({
      id: eventId(row.cycleId, "trial_ended"), userId, subscriptionId: row.id, subscriptionCycleId: row.cycleId,
      eventType: "trial_ended", planKey: TRIAL_PLAN_KEY, occurredAt: now, createdAt: now,
    }).onConflictDoNothing();
    return { status: "ended" as const, subscriptionId: row.id };
  });
  if (result.status === "ended") await runFreeTrialLifecycle({ now, subscriptionId: result.subscriptionId, mailer });
  return { status: result.status };
}

export async function freeTrialStats(now = new Date()): Promise<{
  asOf: string;
  starts: number;
  conversions: number;
  conversionRate: number | null;
  expiredWithoutConversion: number;
  averageDaysToSubscription: number | null;
  messages: Array<{ stepId: string; delivered: number; opened: number; clicked: number; openRate: number | null; clickRate: number | null }>;
}> {
  const [claims, subscriptions, reminders] = await Promise.all([
    db.select().from(trialClaimsTable),
    db.select({ userId: userSubscriptionsTable.userId, trialEndedAt: userSubscriptionsTable.trialEndedAt, subscriptionType: userSubscriptionsTable.subscriptionType })
      .from(userSubscriptionsTable),
    db.select({ stepId: subscriptionRemindersSentTable.trialMessageStepId, deliveryStatus: subscriptionRemindersSentTable.deliveryStatus, openedAt: subscriptionRemindersSentTable.openedAt, clickedAt: subscriptionRemindersSentTable.clickedAt })
      .from(subscriptionRemindersSentTable).where(isNotNull(subscriptionRemindersSentTable.trialMessageStepId)),
  ]);
  const subByUser = new Map(subscriptions.map((row) => [row.userId, row]));
  const starts = claims.length;
  const conversions = claims.filter((claim) => claim.convertedAt).length;
  const expiredWithoutConversion = claims.filter((claim) => {
    if (claim.convertedAt) return false;
    const row = subByUser.get(claim.userId);
    return Boolean(row?.trialEndedAt && row.trialEndedAt.getTime() <= now.getTime());
  }).length;
  const convertedDurations = claims.flatMap((claim) => claim.convertedAt ? [Math.max(0, claim.convertedAt.getTime() - claim.startedAt.getTime())] : []);
  const averageDaysToSubscription = convertedDurations.length
    ? Math.round((convertedDurations.reduce((a, b) => a + b, 0) / convertedDurations.length / (24 * 60 * 60 * 1000)) * 10) / 10
    : null;
  const grouped = new Map<string, { delivered: number; opened: number; clicked: number }>();
  for (const row of reminders) {
    if (!row.stepId) continue;
    const stat = grouped.get(row.stepId) || { delivered: 0, opened: 0, clicked: 0 };
    if (row.deliveryStatus === "delivered") stat.delivered += 1;
    if (row.openedAt) stat.opened += 1;
    if (row.clickedAt) stat.clicked += 1;
    grouped.set(row.stepId, stat);
  }
  return {
    asOf: now.toISOString(), starts, conversions,
    conversionRate: starts ? Math.round((conversions / starts) * 1000) / 10 : null,
    expiredWithoutConversion, averageDaysToSubscription,
    messages: [...grouped.entries()].map(([stepId, stat]) => ({
      stepId, ...stat,
      openRate: stat.delivered ? Math.round((stat.opened / stat.delivered) * 1000) / 10 : null,
      clickRate: stat.delivered ? Math.round((stat.clicked / stat.delivered) * 1000) / 10 : null,
    })),
  };
}

/** True only for an active selected/all feature scope; useful for explicit
 * service-side checks in addition to generic `hasVipFeature`. */
export function trialScopeAllows(scope: unknown, feature: string): boolean {
  return scopeAllows(scope, feature);
}

export { DEFAULT_FREE_TRIAL_SETTINGS };
