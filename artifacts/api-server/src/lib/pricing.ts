/*
 * Central subscription-pricing policy.
 *
 * `getEffectivePrice(user, plan, now)` is the only runtime authority for the
 * amount and presentation shown to a user. Payment creation consumes the same
 * result, so a browser can never choose a different amount from the amount the
 * server records. Offer expiry is time-based here; it does not depend on a
 * cron job or an unreliable browser countdown.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  appSettingsTable,
  appUsersTable,
  paymentRequestsTable,
  planPriceOffersTable,
  subscriptionPlansTable,
  userSubscriptionsTable,
  type PlanPriceOffer,
  type SubscriptionPlan,
} from "@workspace/db/schema";
import type { UserClaims } from "./userAuth";

export const PRICE_AUDIENCES = ["all", "new_users", "expired_subscribers"] as const;
export type PriceAudience = (typeof PRICE_AUDIENCES)[number];
export const PRICE_BADGE_MODES = ["none", "auto", "custom"] as const;
export type PriceBadgeMode = (typeof PRICE_BADGE_MODES)[number];

export const DEFAULT_PAYMENT_PRICE_LOCK_HOURS = 24;
const MAX_PRICE = 10_000_000;
const MAX_BADGE_LENGTH = 50;
type PricingUser = Pick<UserClaims, "sub" | "phone"> | null;

let cacheGeneration = 0;

/**
 * Public pricing deliberately has no retained process cache: an operator's
 * change must be visible to every instance immediately, not after a TTL. This
 * marker still invalidates client/config versions and any future shared cache.
 */
export function invalidatePricingCache(): void {
  cacheGeneration += 1;
}

/** A monotonically changing marker returned with no-store public config. */
export function pricingCacheVersion(): number {
  return cacheGeneration;
}

export class PricingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingInputError";
  }
}

export type ValidatedPricePresentation = {
  price: number;
  oldPrice: number | null;
  badgeMode: PriceBadgeMode;
  badgeText: string | null;
  /** Non-blocking compliance reminder for the operator UI. */
  warnings: string[];
};

function asPositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "string" && value.trim() === "" ? NaN : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_PRICE) {
    throw new PricingInputError(`${label} يجب أن يكون رقماً صحيحاً موجباً`);
  }
  return parsed;
}

function optionalPositiveInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  return asPositiveInteger(value, label);
}

function normalizeBadgeMode(value: unknown): PriceBadgeMode {
  const mode = String(value ?? "none").trim();
  if ((PRICE_BADGE_MODES as readonly string[]).includes(mode)) return mode as PriceBadgeMode;
  throw new PricingInputError("نوع الشارة غير صحيح");
}

/** Validates price/old-price/badge rules shared by plan and offer mutations. */
export function validatePricePresentation(raw: Record<string, unknown>): ValidatedPricePresentation {
  const price = asPositiveInteger(raw["price"], "السعر الحالي");
  const oldPrice = optionalPositiveInteger(raw["oldPrice"], "السعر القديم");
  if (oldPrice !== null && oldPrice <= price) {
    throw new PricingInputError("السعر القديم يجب أن يكون أكبر من السعر الحالي");
  }
  const badgeMode = normalizeBadgeMode(raw["badgeMode"] ?? raw["priceBadgeMode"]);
  const inputBadge = raw["badgeText"] ?? raw["priceBadgeText"];
  const badgeText = inputBadge === undefined || inputBadge === null || String(inputBadge).trim() === ""
    ? null
    : String(inputBadge).trim().slice(0, MAX_BADGE_LENGTH);
  if (badgeMode === "custom" && !badgeText) {
    throw new PricingInputError("اكتب نص الشارة أو اختر بدون شارة");
  }
  if (badgeMode === "auto" && oldPrice === null) {
    throw new PricingInputError("الخصم التلقائي يحتاج سعراً قديماً صحيحاً");
  }
  return {
    price,
    oldPrice,
    badgeMode,
    badgeText: badgeMode === "custom" ? badgeText : null,
    warnings: oldPrice === null ? [] : ["السعر القديم يجب أن يكون سعراً بيعت به الباقة فعلاً"],
  };
}

/**
 * Converts a Cairo wall-clock value from the admin datetime-local field to an
 * instant. ISO values with an explicit offset are already instants; bare
 * values are deliberately interpreted as Africa/Cairo rather than host time.
 */
export function parseCairoDateTime(value: unknown, label: string): Date | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const source = String(value).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(source)) {
    const parsed = new Date(source);
    if (Number.isNaN(parsed.getTime())) throw new PricingInputError(`${label} غير صحيح`);
    return parsed;
  }
  const match = source.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new PricingInputError(`${label} يجب أن يكون بتوقيت القاهرة`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText || 0);
  const intended = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(intended)) throw new PricingInputError(`${label} غير صحيح`);

  let candidate = new Date(intended);
  for (let i = 0; i < 3; i += 1) {
    const displayed = cairoParts(candidate);
    const displayedAsUtc = Date.UTC(displayed.year, displayed.month - 1, displayed.day, displayed.hour, displayed.minute, displayed.second);
    candidate = new Date(intended - (displayedAsUtc - candidate.getTime()));
  }
  const final = cairoParts(candidate);
  if (final.year !== year || final.month !== month || final.day !== day || final.hour !== hour || final.minute !== minute || final.second !== second) {
    /* Covers invalid Cairo wall-clock times around a daylight-saving jump. */
    throw new PricingInputError(`${label} غير صالح بتوقيت القاهرة`);
  }
  return candidate;
}

function cairoParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (name: string) => Number(parts.find((part) => part.type === name)?.value || "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

export function isKnownPriceAudience(value: unknown): value is PriceAudience {
  return (PRICE_AUDIENCES as readonly string[]).includes(String(value));
}

export type ValidatedOfferInput = ValidatedPricePresentation & {
  id?: string;
  audience: PriceAudience;
  startsAt: Date | null;
  endsAt: Date | null;
  showCountdown: boolean;
  priority: number;
};

/** Validates a timed/targeted offer before it can alter any live price. */
export function validatePriceOffer(raw: Record<string, unknown>): ValidatedOfferInput {
  const presentation = validatePricePresentation(raw);
  const audience = String(raw["audience"] ?? "all").trim();
  if (!isKnownPriceAudience(audience)) {
    throw new PricingInputError("فئة الجمهور غير مدعومة حاليًا");
  }
  const startsAt = parseCairoDateTime(raw["startsAt"], "بداية العرض");
  const endsAt = parseCairoDateTime(raw["endsAt"], "نهاية العرض");
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw new PricingInputError("تاريخ نهاية العرض يجب أن يكون بعد تاريخ البداية");
  }
  const showCountdown = raw["showCountdown"] === true || raw["showCountdown"] === "true" || raw["showCountdown"] === 1;
  if (showCountdown && !endsAt) {
    throw new PricingInputError("العداد التنازلي يحتاج تاريخ ووقت نهاية للعرض");
  }
  const priorityRaw = raw["priority"] === undefined || raw["priority"] === null || raw["priority"] === "" ? 0 : Number(raw["priority"]);
  if (!Number.isSafeInteger(priorityRaw) || priorityRaw < -1000 || priorityRaw > 1000) {
    throw new PricingInputError("أولوية العرض غير صحيحة");
  }
  const rawId = raw["id"] === undefined || raw["id"] === null ? "" : String(raw["id"]).trim();
  if (rawId && !/^[A-Za-z0-9_-]{8,100}$/.test(rawId)) throw new PricingInputError("معرّف العرض غير صحيح");
  return { ...presentation, ...(rawId ? { id: rawId } : {}), audience, startsAt, endsAt, showCountdown, priority: priorityRaw };
}

function asDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeOldPrice(oldPrice: number | null | undefined, price: number): number | null {
  return typeof oldPrice === "number" && Number.isSafeInteger(oldPrice) && oldPrice > price ? oldPrice : null;
}

function discountPercent(price: number, oldPrice: number | null): number | null {
  if (!oldPrice || oldPrice <= price) return null;
  return Math.round(((oldPrice - price) / oldPrice) * 100);
}

function resolvedBadge(mode: string | null | undefined, text: string | null | undefined, discount: number | null): string | null {
  if (mode === "auto") return discount === null ? null : `خصم ${discount}%`;
  if (mode === "custom") {
    const cleaned = String(text || "").trim().slice(0, MAX_BADGE_LENGTH);
    return cleaned || null;
  }
  return null;
}

async function loadOffers(planId: number): Promise<PlanPriceOffer[]> {
  /* No TTL cache here: pricing writes must take effect immediately across
   * process instances. The database is the shared source of truth. */
  return db.select().from(planPriceOffersTable).where(eq(planPriceOffersTable.planId, planId));
}

async function audiencesForUser(user: PricingUser, now: Date): Promise<Set<PriceAudience>> {
  const audiences = new Set<PriceAudience>();
  if (!user || !Number.isInteger(user.sub) || user.sub <= 0) return audiences;

  const [account] = await db.select({
    id: appUsersTable.id,
    plan: appUsersTable.plan,
    vipExpiresAt: appUsersTable.vipExpiresAt,
  }).from(appUsersTable).where(eq(appUsersTable.id, user.sub)).limit(1);
  if (!account) return audiences;

  const [subscription] = await db.select({
    expiresAt: userSubscriptionsTable.expiresAt,
    status: userSubscriptionsTable.status,
  }).from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, account.id)).limit(1);
  const [approvedRequest] = await db.select({ id: paymentRequestsTable.id })
    .from(paymentRequestsTable)
    .where(and(eq(paymentRequestsTable.phone, user.phone), eq(paymentRequestsTable.status, "approved")))
    .limit(1);

  if (!subscription && !approvedRequest && account.plan !== "vip") audiences.add("new_users");
  const subscriptionExpired = Boolean(subscription && (subscription.status !== "active" || subscription.expiresAt.getTime() <= now.getTime()));
  const legacyExpired = account.plan === "vip" && account.vipExpiresAt !== null && account.vipExpiresAt.getTime() <= now.getTime();
  if (subscriptionExpired || legacyExpired) audiences.add("expired_subscribers");
  return audiences;
}

export type EffectivePrice = {
  price: number;
  oldPrice: number | null;
  discountPercent: number | null;
  badge: string | null;
  source: "base" | "offer";
  offerId: string | null;
  audience: PriceAudience | "base";
  startsAt: Date | null;
  endsAt: Date | null;
  showCountdown: boolean;
};

function activeMatchingOffer(offers: PlanPriceOffer[], audiences: Set<PriceAudience>, now: Date): PlanPriceOffer | null {
  const nowMs = now.getTime();
  const candidates = offers.filter((offer) => {
    if (offer.status !== "active" || !isKnownPriceAudience(offer.audience)) return false;
    const startsAt = asDate(offer.startsAt);
    const endsAt = asDate(offer.endsAt);
    if (startsAt && startsAt.getTime() > nowMs) return false;
    if (endsAt && endsAt.getTime() <= nowMs) return false;
    return offer.audience === "all" || audiences.has(offer.audience);
  });
  candidates.sort((left, right) => {
    const audienceWeight = (right.audience === "all" ? 0 : 1) - (left.audience === "all" ? 0 : 1);
    if (audienceWeight) return audienceWeight;
    if (right.priority !== left.priority) return right.priority - left.priority;
    const rightStart = asDate(right.startsAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
    const leftStart = asDate(left.startsAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (rightStart !== leftStart) return rightStart - leftStart;
    return (asDate(right.createdAt)?.getTime() ?? 0) - (asDate(left.createdAt)?.getTime() ?? 0);
  });
  return candidates[0] || null;
}

/**
 * The sole runtime price authority. It resolves base pricing, schedule state,
 * audience targeting, strikethrough/discount presentation and countdown data
 * from server records at the supplied instant.
 */
export async function getEffectivePrice(user: PricingUser, plan: SubscriptionPlan, now: Date = new Date()): Promise<EffectivePrice> {
  const offers = await loadOffers(plan.id);
  const audiences = offers.some((offer) => offer.status === "active" && offer.audience !== "all")
    ? await audiencesForUser(user, now)
    : new Set<PriceAudience>();
  const offer = activeMatchingOffer(offers, audiences, now);
  if (!offer) {
    const oldPrice = safeOldPrice(plan.oldPrice, plan.price);
    const discount = discountPercent(plan.price, oldPrice);
    return {
      price: plan.price,
      oldPrice,
      discountPercent: discount,
      badge: resolvedBadge(plan.priceBadgeMode, plan.priceBadgeText, discount),
      source: "base",
      offerId: null,
      audience: "base",
      startsAt: null,
      endsAt: null,
      showCountdown: false,
    };
  }
  const oldPrice = safeOldPrice(offer.oldPrice, offer.price);
  const discount = discountPercent(offer.price, oldPrice);
  const endsAt = asDate(offer.endsAt);
  return {
    price: offer.price,
    oldPrice,
    discountPercent: discount,
    badge: resolvedBadge(offer.badgeMode, offer.badgeText, discount),
    source: "offer",
    offerId: offer.id,
    audience: offer.audience as PriceAudience,
    startsAt: asDate(offer.startsAt),
    endsAt,
    showCountdown: Boolean(offer.showCountdown && endsAt),
  };
}

/* A deterministic freshness token. It carries no authority over price (the
 * server recalculates that), but prevents a modal rendered before a price edit
 * from silently creating a request at a different later amount. */
export function effectivePriceToken(plan: Pick<SubscriptionPlan, "key">, effective: EffectivePrice): string {
  const payload = {
    v: 1,
    plan: plan.key,
    price: effective.price,
    oldPrice: effective.oldPrice,
    discountPercent: effective.discountPercent,
    badge: effective.badge,
    source: effective.source,
    offerId: effective.offerId,
    audience: effective.audience,
    startsAt: effective.startsAt?.toISOString() || null,
    endsAt: effective.endsAt?.toISOString() || null,
    showCountdown: effective.showCountdown,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** Variables for future email/admin-message templates; all derive from the same effective result. */
export function effectivePriceTemplateVariables(effective: EffectivePrice): Record<"price" | "old_price" | "discount_percent", string> {
  return {
    price: String(effective.price),
    old_price: effective.oldPrice === null ? "" : String(effective.oldPrice),
    discount_percent: effective.discountPercent === null ? "" : String(effective.discountPercent),
  };
}

export function interpolatePriceTemplate(template: string, effective: EffectivePrice): string {
  const vars = effectivePriceTemplateVariables(effective);
  return String(template || "").replace(/\{\{(price|old_price|discount_percent)\}\}/g, (_match, key: keyof typeof vars) => vars[key]);
}

export type PaymentPriceSnapshot = {
  version: 1;
  calculatedAt: string;
  lockHours: number;
  effective: EffectivePrice;
  templateVariables: Record<"price" | "old_price" | "discount_percent", string>;
  plan: {
    key: string;
    nameAr: string;
    durationMonths: number;
    features: string[];
  };
};

export function buildPaymentPriceSnapshot(plan: SubscriptionPlan, effective: EffectivePrice, lockHours: number, now: Date): PaymentPriceSnapshot {
  return {
    version: 1,
    calculatedAt: now.toISOString(),
    lockHours,
    effective,
    templateVariables: effectivePriceTemplateVariables(effective),
    plan: {
      key: plan.key,
      nameAr: plan.nameAr,
      durationMonths: plan.durationMonths,
      features: Array.isArray(plan.features) ? plan.features : [],
    },
  };
}

/** Validates an immutable server-created snapshot before payment approval uses it. */
export function readPaymentPriceSnapshot(value: unknown): PaymentPriceSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Partial<PaymentPriceSnapshot>;
  const plan = snapshot.plan;
  const effective = snapshot.effective;
  if (snapshot.version !== 1 || !plan || !effective
    || typeof plan.key !== "string" || typeof plan.nameAr !== "string"
    || !Number.isSafeInteger(plan.durationMonths) || plan.durationMonths < 1
    || !Number.isSafeInteger(effective.price) || effective.price <= 0) return null;
  return snapshot as PaymentPriceSnapshot;
}

export async function getPaymentPriceLockHours(): Promise<number> {
  const [setting] = await db.select({ value: appSettingsTable.value })
    .from(appSettingsTable).where(eq(appSettingsTable.key, "payment_price_lock_hours")).limit(1);
  const value = Number(setting?.value);
  return Number.isSafeInteger(value) && value >= 1 && value <= 168 ? value : DEFAULT_PAYMENT_PRICE_LOCK_HOURS;
}

export function validatePaymentPriceLockHours(value: unknown): number {
  const hours = Number(value);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) {
    throw new PricingInputError("مدة تثبيت السعر يجب أن تكون بين ساعة و168 ساعة");
  }
  return hours;
}
