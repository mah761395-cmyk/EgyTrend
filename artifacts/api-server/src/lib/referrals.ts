/*
 * Referral program authority.
 *
 * No browser-controlled value grants a referral, discount or VIP time.  The
 * browser may carry an opaque signed attribution cookie / optional code, but
 * this module resolves and snapshots the code, campaign and award rules from
 * the database at registration.  All reward writes use durable idempotency
 * keys and an append-only ledger.
 */
import crypto from "node:crypto";
import {
  and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql,
} from "drizzle-orm";
import {
  appUsersTable,
  couponsTable,
  db,
  paymentRequestsTable,
  referralAttributionsTable,
  referralCampaignsTable,
  referralClickEventsTable,
  referralCodesTable,
  referralMessageDeliveriesTable,
  referralMessageTemplatesTable,
  referralProgramSettingsTable,
  referralReviewSignalsTable,
  referralRewardLedgerTable,
  referralRewardsTable,
  referralTiersTable,
  subscriptionPlansTable,
  userNotificationsTable,
  userSubscriptionsTable,
  type ReferralCampaign,
  type ReferralQualificationEvent,
  type ReferralRewardType,
} from "@workspace/db";
import { parseCairoDateTime, PricingInputError } from "./pricing";
import { addCairoCalendarDays, cairoParts } from "./subscription-time";
import { escapeHtml, isSmtpConfigured, sendMail } from "./mailer";
import { extendFreeTrial } from "./free-trials";

const SETTINGS_ID = "default";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RESERVED_CODES = new Set(["ADMIN", "SUPPORT", "EGBTREND", "EGYTREND", "VIP", "FREE", "LOGIN", "REGISTER", "API", "NULL", "UNDEFINED"]);
const MAX_TEMPLATE_LENGTH = 4_000;
const MAX_TERMS_LENGTH = 12_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_REFERRAL_SETTINGS = {
  enabled: false,
  attributionCookieDays: 30,
  termsText: "",
} as const;

export type ReferralSettings = { enabled: boolean; attributionCookieDays: number; termsText: string };
export type ReferralRuleSnapshot = {
  campaignId: string;
  campaignName: string;
  qualificationEvent: ReferralQualificationEvent;
  holdDays: number;
  referrerRewardType: ReferralRewardType;
  referrerRewardValue: number;
  referrerRewardCost: number | null;
  inviteeRewardType: ReferralRewardType;
  inviteeRewardValue: number;
  inviteeRewardCost: number | null;
  maxReferrerMonthly: number | null;
  maxReferrerTotal: number | null;
  createdAt: string;
};

type DbExecutor = typeof db | any;

function id(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(15).toString("hex")}`;
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/<\s*\/??\s*(?:script|style|iframe|object|embed)[^>]*>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, max);
}

function normalizeCode(value: unknown): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,32}$/.test(code) || RESERVED_CODES.has(code)) return null;
  return code;
}

function generatedCode(): string {
  const bytes = crypto.randomBytes(8);
  let result = "";
  for (let i = 0; i < 8; i += 1) result += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return result;
}

function nowValid(now: Date): boolean { return now instanceof Date && Number.isFinite(now.getTime()); }

function canonicalEmail(raw: string | null | undefined): string | null {
  const value = String(raw || "").trim().toLowerCase();
  const parts = value.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!parts) return null;
  let local = parts[1]!;
  let domain = parts[2]!;
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.replace(/\+.*/, "");
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local && domain ? `${local}@${domain}` : null;
}

/** Conservative disposable-domain check used only to deny referral credit, never account registration. */
function disposableEmail(email: string | null): boolean {
  if (!email) return false;
  const domain = email.split("@")[1] || "";
  return /(?:^|\.)(?:mailinator|guerrillamail|tempmail|10minutemail|yopmail|throwaway|dispostable|trashmail)\./i.test(`.${domain}.`)
    || /(?:mailinator|guerrillamail|tempmail|10minutemail|yopmail|throwaway|dispostable|trashmail)/i.test(domain);
}

function signalHash(kind: string, value: string): string | null {
  const clean = String(value || "").trim();
  if (!clean) return null;
  const key = process.env["REFERRAL_SIGNAL_SECRET"] || process.env["SESSION_SECRET"] || "referral-local-signal-not-for-production";
  return crypto.createHmac("sha256", key).update(`${kind}:${clean}`).digest("hex");
}

export function referralProofHash(value: string): string | null {
  const text = String(value || "");
  return text ? crypto.createHash("sha256").update(text).digest("hex") : null;
}

function dateOrNull(value: unknown): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isActiveCampaign(campaign: Pick<ReferralCampaign, "status" | "startsAt" | "endsAt">, now: Date): boolean {
  if (campaign.status !== "active") return false;
  const start = dateOrNull(campaign.startsAt), end = dateOrNull(campaign.endsAt);
  return (!start || start.getTime() <= now.getTime()) && (!end || end.getTime() > now.getTime());
}

function optionalInteger(value: unknown, min: number, max: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

function rewardType(value: unknown): ReferralRewardType | null {
  const type = String(value || "");
  return (["vip_days", "coupon", "renewal_credit", "first_subscription_percent", "first_subscription_amount", "trial_extra_days"] as const).includes(type as ReferralRewardType)
    ? type as ReferralRewardType : null;
}

function qualificationEvent(value: unknown): ReferralQualificationEvent | null {
  const event = String(value || "");
  return (["email_verified", "trial_started", "first_paid"] as const).includes(event as ReferralQualificationEvent)
    ? event as ReferralQualificationEvent : null;
}

function campaignRule(campaign: ReferralCampaign, override: unknown, now: Date): ReferralRuleSnapshot {
  const base: ReferralRuleSnapshot = {
    campaignId: campaign.id,
    campaignName: campaign.name,
    qualificationEvent: qualificationEvent(campaign.qualificationEvent) || "first_paid",
    holdDays: Number.isInteger(campaign.holdDays) ? Math.max(0, Math.min(90, campaign.holdDays)) : 7,
    referrerRewardType: rewardType(campaign.referrerRewardType) || "vip_days",
    referrerRewardValue: Math.max(1, Number(campaign.referrerRewardValue) || 1),
    referrerRewardCost: Number.isInteger(campaign.referrerRewardCost) ? campaign.referrerRewardCost : null,
    inviteeRewardType: rewardType(campaign.inviteeRewardType) || "first_subscription_percent",
    inviteeRewardValue: Math.max(0, Number(campaign.inviteeRewardValue) || 0),
    inviteeRewardCost: Number.isInteger(campaign.inviteeRewardCost) ? campaign.inviteeRewardCost : null,
    maxReferrerMonthly: Number.isInteger(campaign.maxReferrerMonthly) ? campaign.maxReferrerMonthly : null,
    maxReferrerTotal: Number.isInteger(campaign.maxReferrerTotal) ? campaign.maxReferrerTotal : null,
    createdAt: now.toISOString(),
  };
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const o = override as Record<string, unknown>;
  const event = qualificationEvent(o.qualificationEvent);
  const refType = rewardType(o.referrerRewardType);
  const invType = rewardType(o.inviteeRewardType);
  const hold = optionalInteger(o.holdDays, 0, 90);
  const refValue = optionalInteger(o.referrerRewardValue, 1, 1_000_000);
  const invValue = optionalInteger(o.inviteeRewardValue, 0, 1_000_000);
  return {
    ...base,
    ...(event ? { qualificationEvent: event } : {}),
    ...(refType ? { referrerRewardType: refType } : {}),
    ...(invType ? { inviteeRewardType: invType } : {}),
    ...(hold !== null ? { holdDays: hold } : {}),
    ...(refValue !== null ? { referrerRewardValue: refValue } : {}),
    ...(invValue !== null ? { inviteeRewardValue: invValue } : {}),
    ...(optionalInteger(o.maxReferrerMonthly, 1, 1_000_000) !== null ? { maxReferrerMonthly: optionalInteger(o.maxReferrerMonthly, 1, 1_000_000) } : {}),
    ...(optionalInteger(o.maxReferrerTotal, 1, 1_000_000) !== null ? { maxReferrerTotal: optionalInteger(o.maxReferrerTotal, 1, 1_000_000) } : {}),
  };
}

function asRule(value: unknown): ReferralRuleSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const event = qualificationEvent(v.qualificationEvent), referrerType = rewardType(v.referrerRewardType), inviteeType = rewardType(v.inviteeRewardType);
  const referrerRewardValue = Number(v.referrerRewardValue), inviteeRewardValue = Number(v.inviteeRewardValue), holdDays = Number(v.holdDays);
  if (!event || !referrerType || !inviteeType || !Number.isSafeInteger(referrerRewardValue) || referrerRewardValue < 1
    || !Number.isSafeInteger(inviteeRewardValue) || inviteeRewardValue < 0 || !Number.isSafeInteger(holdDays) || holdDays < 0 || holdDays > 90) return null;
  return {
    campaignId: cleanText(v.campaignId, 100),
    campaignName: cleanText(v.campaignName, 120) || "حملة إحالة",
    qualificationEvent: event, holdDays, referrerRewardType: referrerType, referrerRewardValue,
    referrerRewardCost: Number.isInteger(v.referrerRewardCost) ? Number(v.referrerRewardCost) : null,
    inviteeRewardType: inviteeType, inviteeRewardValue,
    inviteeRewardCost: Number.isInteger(v.inviteeRewardCost) ? Number(v.inviteeRewardCost) : null,
    maxReferrerMonthly: Number.isInteger(v.maxReferrerMonthly) ? Number(v.maxReferrerMonthly) : null,
    maxReferrerTotal: Number.isInteger(v.maxReferrerTotal) ? Number(v.maxReferrerTotal) : null,
    createdAt: typeof v.createdAt === "string" ? v.createdAt : new Date().toISOString(),
  };
}

function referralMessageDefaults() {
  return [
    { eventKey: "friend_registered", channels: ["in_app", "email"], titleTemplate: "سجّل صديقك عبر دعوتك", bodyTemplate: "مرحبًا {{name}}، سجّل {{friend_name}} عبر رابط دعوتك. ستظهر حالة المكافأة هنا عند اكتمال شروط الحملة." },
    { eventKey: "reward_granted", channels: ["in_app", "email"], titleTemplate: "تم منح مكافأة الإحالة", bodyTemplate: "مرحبًا {{name}}، حصلت على {{reward}} بسبب دعوة {{friend_name}}. عدد الأيام: {{days}}." },
  ];
}

export async function readReferralSettings(): Promise<ReferralSettings> {
  const [row] = await db.select().from(referralProgramSettingsTable).where(eq(referralProgramSettingsTable.id, SETTINGS_ID)).limit(1);
  if (!row) return { ...DEFAULT_REFERRAL_SETTINGS };
  return {
    enabled: row.enabled === true,
    attributionCookieDays: Number.isInteger(row.attributionCookieDays) && row.attributionCookieDays >= 1 && row.attributionCookieDays <= 90 ? row.attributionCookieDays : 30,
    termsText: cleanText(row.termsText, MAX_TERMS_LENGTH),
  };
}

export function validateReferralSettings(input: unknown): ReferralSettings | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  const days = Number(v.attributionCookieDays);
  if (typeof v.enabled !== "boolean" || !Number.isSafeInteger(days) || days < 1 || days > 90) return null;
  return { enabled: v.enabled, attributionCookieDays: days, termsText: cleanText(v.termsText, MAX_TERMS_LENGTH) };
}

export async function saveReferralSettings(settings: ReferralSettings, actorEmployeeId: number | null, now = new Date()): Promise<void> {
  await db.insert(referralProgramSettingsTable).values({ id: SETTINGS_ID, ...settings, updatedBy: actorEmployeeId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: referralProgramSettingsTable.id, set: { ...settings, updatedBy: actorEmployeeId, updatedAt: now } });
}

export type ValidCampaignInput = {
  name: string; status: "active" | "paused"; priority: number; startsAt: Date | null; endsAt: Date | null;
  qualificationEvent: ReferralQualificationEvent; holdDays: number;
  referrerRewardType: ReferralRewardType; referrerRewardValue: number; referrerRewardCost: number | null;
  inviteeRewardType: ReferralRewardType; inviteeRewardValue: number; inviteeRewardCost: number | null;
  maxReferrerMonthly: number | null; maxReferrerTotal: number | null;
};

export function validateReferralCampaign(input: unknown): ValidCampaignInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  const name = cleanText(v.name, 120), status = String(v.status || "paused");
  const priority = Number(v.priority ?? 0), holdDays = Number(v.holdDays ?? 7);
  const event = qualificationEvent(v.qualificationEvent), refType = rewardType(v.referrerRewardType), invType = rewardType(v.inviteeRewardType);
  const refValue = Number(v.referrerRewardValue), invValue = Number(v.inviteeRewardValue);
  if (!name || !["active", "paused"].includes(status) || !Number.isSafeInteger(priority) || priority < -1000 || priority > 1000
    || !event || !refType || !invType || !Number.isSafeInteger(holdDays) || holdDays < 0 || holdDays > 90
    || !Number.isSafeInteger(refValue) || refValue < 1 || refValue > 1_000_000
    || !Number.isSafeInteger(invValue) || invValue < 0 || invValue > 1_000_000) return null;
  let startsAt: Date | null, endsAt: Date | null;
  try { startsAt = parseCairoDateTime(v.startsAt, "بداية الحملة"); endsAt = parseCairoDateTime(v.endsAt, "نهاية الحملة"); } catch { return null; }
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) return null;
  const refCost = optionalInteger(v.referrerRewardCost, 0, 1_000_000_000), invCost = optionalInteger(v.inviteeRewardCost, 0, 1_000_000_000);
  const monthly = optionalInteger(v.maxReferrerMonthly, 1, 1_000_000), total = optionalInteger(v.maxReferrerTotal, 1, 1_000_000);
  return { name, status: status as "active" | "paused", priority, startsAt, endsAt, qualificationEvent: event, holdDays,
    referrerRewardType: refType, referrerRewardValue: refValue, referrerRewardCost: refCost,
    inviteeRewardType: invType, inviteeRewardValue: invValue, inviteeRewardCost: invCost,
    maxReferrerMonthly: monthly, maxReferrerTotal: total };
}

export async function createReferralCampaign(input: ValidCampaignInput, actorEmployeeId: number | null, now = new Date()) {
  const row = { id: id("refcamp"), ...input, createdBy: actorEmployeeId, updatedBy: actorEmployeeId, createdAt: now, updatedAt: now };
  const [created] = await db.insert(referralCampaignsTable).values(row).returning();
  return created!;
}

export async function updateReferralCampaign(campaignId: string, input: ValidCampaignInput, actorEmployeeId: number | null, now = new Date()) {
  const [updated] = await db.update(referralCampaignsTable).set({ ...input, updatedBy: actorEmployeeId, updatedAt: now })
    .where(and(eq(referralCampaignsTable.id, campaignId), ne(referralCampaignsTable.status, "archived"))).returning();
  return updated || null;
}

export async function archiveReferralCampaign(campaignId: string, actorEmployeeId: number | null, now = new Date()) {
  const [updated] = await db.update(referralCampaignsTable).set({ status: "archived", archivedAt: now, updatedBy: actorEmployeeId, updatedAt: now })
    .where(and(eq(referralCampaignsTable.id, campaignId), ne(referralCampaignsTable.status, "archived"))).returning();
  return updated || null;
}

export type ValidReferralTierInput = { campaignId: string; threshold: number; rewardType: ReferralRewardType; rewardValue: number; rewardCost: number | null; status: "active" | "paused" };
export function validateReferralTier(input: unknown): ValidReferralTierInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>, campaignId = cleanText(v.campaignId, 100), threshold = Number(v.threshold), value = Number(v.rewardValue), type = rewardType(v.rewardType), status = String(v.status || "active");
  const cost = optionalInteger(v.rewardCost, 0, 1_000_000_000);
  if (!campaignId || !type || !Number.isSafeInteger(threshold) || threshold < 1 || threshold > 1_000_000 || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000 || !["active", "paused"].includes(status) || (cost === null && v.rewardCost !== undefined && v.rewardCost !== "")) return null;
  return { campaignId, threshold, rewardType: type, rewardValue: value, rewardCost: cost, status: status as "active" | "paused" };
}
export async function createReferralTier(input: ValidReferralTierInput, employeeId: number | null, now = new Date()) {
  const [campaign] = await db.select({ id: referralCampaignsTable.id }).from(referralCampaignsTable).where(eq(referralCampaignsTable.id, input.campaignId)).limit(1);
  if (!campaign) return null;
  try {
    const [created] = await db.insert(referralTiersTable).values({ id: id("reftier"), ...input, createdBy: employeeId, updatedBy: employeeId, createdAt: now, updatedAt: now }).returning();
    return created || null;
  } catch (error) { if (/unique/i.test(String(error))) return null; throw error; }
}
export async function updateReferralTier(tierId: string, input: ValidReferralTierInput, employeeId: number | null, now = new Date()) {
  const [updated] = await db.update(referralTiersTable).set({ ...input, updatedBy: employeeId, updatedAt: now }).where(and(eq(referralTiersTable.id, tierId), ne(referralTiersTable.status, "archived"))).returning();
  return updated || null;
}
export async function archiveReferralTier(tierId: string, employeeId: number | null, now = new Date()) {
  const [updated] = await db.update(referralTiersTable).set({ status: "archived", archivedAt: now, updatedBy: employeeId, updatedAt: now }).where(and(eq(referralTiersTable.id, tierId), ne(referralTiersTable.status, "archived"))).returning();
  return updated || null;
}

async function allocateReferralCode(userId: number, now: Date): Promise<typeof referralCodesTable.$inferSelect> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = generatedCode();
    try {
      const [created] = await db.insert(referralCodesTable).values({ id: id("refcode"), code: candidate, kind: "user", ownerUserId: userId, status: "active", createdAt: now, updatedAt: now }).returning();
      if (created) return created;
    } catch (error) {
      if (!/unique/i.test(String(error))) throw error;
      /* A concurrent dashboard request may already have allocated this user's
       * active code. Return it rather than accidentally creating another. */
      const [active] = await db.select().from(referralCodesTable).where(and(
        eq(referralCodesTable.ownerUserId, userId), eq(referralCodesTable.kind, "user"), eq(referralCodesTable.status, "active"),
      )).limit(1);
      if (active) return active;
    }
  }
  throw new Error("Unable to allocate referral code");
}

export async function ensureReferralCode(userId: number, now = new Date()): Promise<typeof referralCodesTable.$inferSelect> {
  /* Prefer the current active code after an admin regeneration. A disabled
   * code is intentionally returned when it is the only one, so viewing the
   * dashboard never silently defeats an administrator's disable action. */
  const [active] = await db.select().from(referralCodesTable).where(and(
    eq(referralCodesTable.ownerUserId, userId), eq(referralCodesTable.kind, "user"), eq(referralCodesTable.status, "active"),
  )).limit(1);
  if (active) return active;
  const [inactive] = await db.select().from(referralCodesTable).where(and(
    eq(referralCodesTable.ownerUserId, userId), eq(referralCodesTable.kind, "user"),
  )).limit(1);
  if (inactive) return inactive;
  return allocateReferralCode(userId, now);
}

async function selectedCampaign(database: DbExecutor, codeCampaignId: string | null, now: Date): Promise<ReferralCampaign | null> {
  if (codeCampaignId) {
    const [campaign] = await database.select().from(referralCampaignsTable).where(eq(referralCampaignsTable.id, codeCampaignId)).limit(1);
    return campaign && isActiveCampaign(campaign, now) ? campaign : null;
  }
  const campaigns = await database.select().from(referralCampaignsTable).where(eq(referralCampaignsTable.status, "active"));
  return campaigns.filter((campaign: ReferralCampaign) => isActiveCampaign(campaign, now)).sort((a: ReferralCampaign, b: ReferralCampaign) =>
    b.priority - a.priority || (dateOrNull(b.startsAt)?.getTime() || 0) - (dateOrNull(a.startsAt)?.getTime() || 0) || b.createdAt.getTime() - a.createdAt.getTime())[0] || null;
}

async function validCode(database: DbExecutor, codeValue: string, now: Date) {
  const [row] = await database.select({
    code: referralCodesTable,
    owner: { id: appUsersTable.id, name: appUsersTable.name, email: appUsersTable.email, phone: appUsersTable.phone, status: appUsersTable.status },
  }).from(referralCodesTable).leftJoin(appUsersTable, eq(referralCodesTable.ownerUserId, appUsersTable.id))
    .where(eq(referralCodesTable.code, codeValue)).limit(1);
  if (!row || row.code.status !== "active" || row.code.archivedAt || (row.code.expiresAt && row.code.expiresAt.getTime() <= now.getTime())) return null;
  if (row.code.ownerUserId && (!row.owner || row.owner.status !== "active")) return null;
  const campaign = await selectedCampaign(database, row.code.campaignId, now);
  return campaign ? { ...row, campaign } : null;
}

async function signalCount(database: DbExecutor, column: typeof referralAttributionsTable.ipSignalHash | typeof referralAttributionsTable.deviceSignalHash, hash: string | null, from: Date): Promise<number> {
  if (!hash) return 0;
  const [row] = await database.select({ count: sql<number>`count(*)` }).from(referralAttributionsTable)
    .where(and(eq(column, hash), gte(referralAttributionsTable.createdAt, from)));
  return Number(row?.count || 0);
}

async function addSignal(database: DbExecutor, attributionId: string, signalType: string, detail: Record<string, unknown>, now: Date): Promise<void> {
  await database.insert(referralReviewSignalsTable).values({ id: id("refsig"), attributionId, signalType, detail, createdAt: now }).onConflictDoNothing();
}

/**
 * Runs only inside the new-account registration path. Invalid/expired codes
 * intentionally produce no distinguishable error; account registration still
 * succeeds and an existing account can never be attributed later.
 */
export async function attachReferralAtRegistration(input: {
  userId: number; email: string | null; phone: string; code: string | null; ip: string; device: string; now?: Date; database?: DbExecutor;
}): Promise<{ attributionId: string | null; attached: boolean; referrerUserId: number | null }> {
  const now = input.now || new Date();
  const database = input.database || db;
  if (!nowValid(now)) return { attributionId: null, attached: false, referrerUserId: null };
  const settings = await (database === db ? readReferralSettings() : database.select().from(referralProgramSettingsTable).where(eq(referralProgramSettingsTable.id, SETTINGS_ID)).limit(1).then((r: any[]) => r[0] ? ({ enabled: r[0].enabled, attributionCookieDays: r[0].attributionCookieDays, termsText: r[0].termsText }) : DEFAULT_REFERRAL_SETTINGS));
  if (!settings.enabled) return { attributionId: null, attached: false, referrerUserId: null };
  const normalized = normalizeCode(input.code);
  if (!normalized) return { attributionId: null, attached: false, referrerUserId: null };
  const resolved = await validCode(database, normalized, now);
  if (!resolved) return { attributionId: null, attached: false, referrerUserId: null };
  const campaign = resolved.campaign;
  const rule = campaignRule(campaign, resolved.code.ruleOverride, now);
  const canonicalInvitee = canonicalEmail(input.email);
  const owner = resolved.owner;
  let blockedReason: string | null = null;
  if (resolved.code.ownerUserId === input.userId) blockedReason = "self_account";
  else if (owner?.phone && owner.phone === input.phone) blockedReason = "same_phone";
  else if (owner?.email && canonicalInvitee && canonicalEmail(owner.email) === canonicalInvitee) blockedReason = "same_canonical_email";
  else if (!canonicalInvitee) blockedReason = "email_not_verified";
  else if (disposableEmail(canonicalInvitee)) blockedReason = "disposable_email";

  const attributionId = id("refattr");
  const ipHash = signalHash("ip", input.ip), deviceHash = signalHash("device", input.device);
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [ipCount, deviceCount] = await Promise.all([signalCount(database, referralAttributionsTable.ipSignalHash, ipHash, from), signalCount(database, referralAttributionsTable.deviceSignalHash, deviceHash, from)]);
  const [velocity] = resolved.code.ownerUserId ? await database.select({ count: sql<number>`count(*)` }).from(referralAttributionsTable)
    .where(and(eq(referralAttributionsTable.referrerUserId, resolved.code.ownerUserId), gte(referralAttributionsTable.createdAt, from))) : [{ count: 0 }];
  const suspicious = !blockedReason && (ipCount >= 1 || deviceCount >= 1 || Number(velocity?.count || 0) >= 5);
  const reviewReason = suspicious ? [ipCount >= 1 ? "shared_ip_velocity" : "", deviceCount >= 1 ? "shared_device_velocity" : "", Number(velocity?.count || 0) >= 5 ? "referrer_velocity" : ""].filter(Boolean).join(",") : null;
  try {
    await database.insert(referralAttributionsTable).values({
      id: attributionId, invitedUserId: input.userId, referrerUserId: resolved.code.ownerUserId || null, codeId: resolved.code.id,
      campaignId: campaign.id, codeSnapshot: resolved.code.code, ruleSnapshot: rule, status: blockedReason ? "blocked" : suspicious ? "review" : "registered",
      reviewStatus: blockedReason ? "rejected" : suspicious ? "pending" : "not_required", ipSignalHash: ipHash, deviceSignalHash: deviceHash,
      suspicious, blockedReason, reviewReason, createdAt: now, updatedAt: now,
    });
  } catch (error) {
    if (/unique/i.test(String(error))) return { attributionId: null, attached: false, referrerUserId: null };
    throw error;
  }
  if (suspicious) {
    if (ipCount >= 1) await addSignal(database, attributionId, "shared_ip_velocity", { previousRegistrations24h: ipCount }, now);
    if (deviceCount >= 1) await addSignal(database, attributionId, "shared_device_velocity", { previousRegistrations24h: deviceCount }, now);
    if (Number(velocity?.count || 0) >= 5) await addSignal(database, attributionId, "referrer_velocity", { registrations24h: Number(velocity.count || 0) }, now);
  }
  return { attributionId, attached: !blockedReason, referrerUserId: blockedReason ? null : resolved.code.ownerUserId || null };
}

function templateVariables(values: Record<string, string>): Record<string, string> {
  return {
    name: values.name || "",
    reward: values.reward || "",
    friend_name: values.friend_name || "",
    days: values.days || "",
  };
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return cleanText(template, MAX_TEMPLATE_LENGTH).replace(/\{\{(name|reward|friend_name|days)\}\}/g, (_m, key) => vars[key] || "");
}

async function defaultOrStoredTemplate(eventKey: string) {
  const [template] = await db.select().from(referralMessageTemplatesTable).where(eq(referralMessageTemplatesTable.eventKey, eventKey)).limit(1);
  if (template?.status === "active") return template;
  const fallback = referralMessageDefaults().find((item) => item.eventKey === eventKey);
  return fallback ? { id: null, ...fallback, status: "active", version: 1 } : null;
}

/** Best-effort transactional notification/email reservation; duplicate workers cannot resend. */
export async function deliverReferralMessage(input: { deliveryKey: string; recipientUserId: number; eventKey: "friend_registered" | "reward_granted"; vars: Record<string, string>; now?: Date }): Promise<void> {
  const now = input.now || new Date();
  const template = await defaultOrStoredTemplate(input.eventKey);
  if (!template) return;
  const [user] = await db.select({ phone: appUsersTable.phone, email: appUsersTable.email, emailVerifiedAt: appUsersTable.emailVerifiedAt, name: appUsersTable.name })
    .from(appUsersTable).where(eq(appUsersTable.id, input.recipientUserId)).limit(1);
  if (!user) return;
  const vars = templateVariables({ ...input.vars, name: input.vars.name || user.name || "" });
  const title = renderTemplate(template.titleTemplate, vars);
  const body = renderTemplate(template.bodyTemplate, vars);
  if (!title || !body) return;
  const channels = Array.isArray(template.channels) ? template.channels : ["in_app"];
  const notificationId = channels.includes("in_app") ? id("refnotif") : null;
  try {
    const [delivery] = await db.insert(referralMessageDeliveriesTable).values({
      id: id("refmsg"), deliveryKey: input.deliveryKey, recipientUserId: input.recipientUserId, templateId: template.id,
      eventKey: input.eventKey, notificationId, emailStatus: channels.includes("email") ? "pending" : "not_requested",
      contentSnapshot: { title, body, vars, templateVersion: template.version }, createdAt: now, updatedAt: now,
    }).onConflictDoNothing().returning();
    if (!delivery) return;
    if (notificationId) {
      await db.insert(userNotificationsTable).values({ id: notificationId, phone: user.phone, kind: "referral", title, body, actionUrl: "/", actionLabel: "عرض الإحالات", createdAt: now });
    }
    if (channels.includes("email")) {
      if (!user.email || !user.emailVerifiedAt || !isSmtpConfigured()) {
        await db.update(referralMessageDeliveriesTable).set({ emailStatus: "unavailable", updatedAt: new Date() }).where(eq(referralMessageDeliveriesTable.id, delivery.id));
      } else {
        const result = await sendMail(user.email, title.slice(0, 180), `<div dir="rtl"><h2>${escapeHtml(title)}</h2><p style="white-space:pre-line">${escapeHtml(body)}</p></div>`);
        await db.update(referralMessageDeliveriesTable).set({ emailStatus: result.delivered ? "sent" : "unavailable", updatedAt: new Date() }).where(eq(referralMessageDeliveriesTable.id, delivery.id));
      }
    }
  } catch {
    /* Notification/e-mail delivery never changes attribution/reward truth. */
  }
}

async function createInviteePurchaseReward(attribution: typeof referralAttributionsTable.$inferSelect, rule: ReferralRuleSnapshot, now: Date): Promise<void> {
  if (!["first_subscription_percent", "first_subscription_amount"].includes(rule.inviteeRewardType) || rule.inviteeRewardValue <= 0) return;
  const key = `invitee:${attribution.id}`;
  const [existing] = await db.select().from(referralRewardsTable).where(eq(referralRewardsTable.idempotencyKey, key)).limit(1);
  if (existing || attribution.reviewStatus === "pending" || attribution.status === "blocked") return;
  const couponCode = `R${crypto.randomBytes(7).toString("hex").toUpperCase()}`;
  try {
    const [coupon] = await db.insert(couponsTable).values({
      code: couponCode, discountType: rule.inviteeRewardType === "first_subscription_percent" ? "percent" : "amount", discountValue: rule.inviteeRewardValue,
      maxUses: 1, usedCount: 0, isActive: true, ownerUserId: attribution.invitedUserId, firstSubscriptionOnly: true, autoApply: true,
      createdAt: now,
    }).returning();
    if (!coupon) return;
    const rewardId = id("refreward");
    await db.insert(referralRewardsTable).values({
      id: rewardId, attributionId: attribution.id, campaignId: attribution.campaignId, recipientUserId: attribution.invitedUserId,
      recipientRole: "invitee", rewardType: rule.inviteeRewardType, rewardValue: rule.inviteeRewardValue, estimatedCost: rule.inviteeRewardCost,
      status: "pending", qualificationEvent: "first_paid", couponId: coupon.id, idempotencyKey: key, ruleSnapshot: rule,
      reason: "invitee_first_subscription_reserved", createdAt: now, updatedAt: now,
    });
    await db.update(couponsTable).set({ referralRewardId: rewardId }).where(eq(couponsTable.id, coupon.id));
    await addRewardLedger(rewardId, "created", null, "حُجز خصم المدعو تلقائيًا لأول اشتراك", {}, now);
  } catch (error) {
    if (!/unique/i.test(String(error))) throw error;
  }
}

async function addRewardLedger(rewardId: string, action: string, actorEmployeeId: number | null, reason: string | null, detail: Record<string, unknown>, now: Date): Promise<void> {
  await db.insert(referralRewardLedgerTable).values({ id: id("refledger"), rewardId, action, actorEmployeeId, reason, detail, createdAt: now });
}

async function rewardCapReached(referrerUserId: number, rule: ReferralRuleSnapshot, now: Date): Promise<{ reached: boolean; reason: string | null }> {
  if (!rule.maxReferrerMonthly && !rule.maxReferrerTotal) return { reached: false, reason: null };
  const p = cairoParts(now);
  const monthStart = new Date(Date.UTC(p.year, p.month - 1, 1, 0, 0, 0));
  const { cairoWallClockToUtc } = await import("./subscription-time");
  const cairoMonthStart = cairoWallClockToUtc({ year: p.year, month: p.month, day: 1, hour: 0, minute: 0, second: 0 });
  const base = and(eq(referralRewardsTable.recipientUserId, referrerUserId), eq(referralRewardsTable.campaignId, rule.campaignId), eq(referralRewardsTable.recipientRole, "referrer"), inArray(referralRewardsTable.status, ["pending", "eligible", "granted"]));
  const [totalRows, monthRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(referralRewardsTable).where(base),
    db.select({ count: sql<number>`count(*)` }).from(referralRewardsTable).where(and(base, gte(referralRewardsTable.createdAt, cairoMonthStart || monthStart))),
  ]);
  const totalRow = totalRows[0], monthRow = monthRows[0];
  if (rule.maxReferrerTotal && Number(totalRow?.count || 0) >= rule.maxReferrerTotal) return { reached: true, reason: "total_cap" };
  if (rule.maxReferrerMonthly && Number(monthRow?.count || 0) >= rule.maxReferrerMonthly) return { reached: true, reason: "monthly_cap" };
  return { reached: false, reason: null };
}

async function createReferrerReward(attribution: typeof referralAttributionsTable.$inferSelect, rule: ReferralRuleSnapshot, event: ReferralQualificationEvent, paymentRequestId: string | null, now: Date): Promise<void> {
  if (!attribution.referrerUserId) return;
  const cap = await rewardCapReached(attribution.referrerUserId, rule, now);
  if (cap.reached) {
    const capReason = cap.reason || "reward_cap";
    await db.update(referralAttributionsTable).set({ status: "qualified", reviewReason: capReason, updatedAt: now }).where(eq(referralAttributionsTable.id, attribution.id));
    /* Clear, durable explanation for the referrer. It is reserved through the
     * delivery table so event retries cannot create duplicate notifications. */
    const deliveryKey = `cap:${attribution.id}`;
    const [delivery] = await db.insert(referralMessageDeliveriesTable).values({
      id: id("refmsg"), deliveryKey, recipientUserId: attribution.referrerUserId, templateId: null, eventKey: "reward_cap",
      notificationId: id("refnotif"), emailStatus: "not_requested", contentSnapshot: { reason: capReason }, createdAt: now, updatedAt: now,
    }).onConflictDoNothing().returning();
    if (delivery?.notificationId) {
      const [recipient] = await db.select({ phone: appUsersTable.phone }).from(appUsersTable).where(eq(appUsersTable.id, attribution.referrerUserId)).limit(1);
      if (recipient) await db.insert(userNotificationsTable).values({
        id: delivery.notificationId, phone: recipient.phone, kind: "referral", title: "تم تسجيل دعوة جديدة", body: capReason === "monthly_cap" ? "وصلت إلى سقف مكافآت الإحالة لهذا الشهر؛ سُجلت الدعوة دون جائزة إضافية." : "وصلت إلى سقف مكافآت الإحالة الإجمالي؛ سُجلت الدعوة دون جائزة إضافية.", createdAt: now,
      });
    }
    return;
  }
  const key = `referrer:${attribution.id}:${paymentRequestId || event}`;
  const holdUntil = event === "first_paid" && rule.holdDays > 0 ? addCairoCalendarDays(now, rule.holdDays) : null;
  const status = holdUntil ? "pending" : "eligible";
  try {
    const rewardId = id("refreward");
    const [reward] = await db.insert(referralRewardsTable).values({
      id: rewardId, attributionId: attribution.id, campaignId: attribution.campaignId, recipientUserId: attribution.referrerUserId,
      recipientRole: "referrer", rewardType: rule.referrerRewardType, rewardValue: rule.referrerRewardValue,
      estimatedCost: rule.referrerRewardCost, status, qualificationEvent: event, holdUntil, paymentRequestId,
      idempotencyKey: key, ruleSnapshot: rule, reason: holdUntil ? "awaiting_payment_hold" : "qualification_met", createdAt: now, updatedAt: now,
    }).returning();
    if (reward) await addRewardLedger(rewardId, "created", null, holdUntil ? "قيد فترة الانتظار" : "مستحقة للمنح", { event, holdUntil: holdUntil?.toISOString() || null }, now);
  } catch (error) {
    if (!/unique/i.test(String(error))) throw error;
  }
}

async function createTierRewards(attribution: typeof referralAttributionsTable.$inferSelect, rule: ReferralRuleSnapshot, now: Date): Promise<void> {
  if (!attribution.referrerUserId) return;
  const tiers = await db.select().from(referralTiersTable).where(and(eq(referralTiersTable.campaignId, attribution.campaignId), eq(referralTiersTable.status, "active")));
  if (!tiers.length) return;
  const [conversion] = await db.select({ count: sql<number>`count(*)` }).from(referralAttributionsTable)
    .where(and(eq(referralAttributionsTable.referrerUserId, attribution.referrerUserId), eq(referralAttributionsTable.campaignId, attribution.campaignId), eq(referralAttributionsTable.status, "qualified")));
  const qualified = Number(conversion?.count || 0);
  for (const tier of tiers) {
    if (qualified < tier.threshold) continue;
    const type = rewardType(tier.rewardType);
    if (!type) continue;
    const rewardId = id("refreward"), key = `tier:${attribution.campaignId}:${attribution.referrerUserId}:${tier.id}`;
    try {
      const [created] = await db.insert(referralRewardsTable).values({
        id: rewardId, attributionId: attribution.id, campaignId: attribution.campaignId, tierId: tier.id, recipientUserId: attribution.referrerUserId,
        recipientRole: "tier", rewardType: type, rewardValue: tier.rewardValue, estimatedCost: tier.rewardCost, status: "eligible",
        qualificationEvent: "first_paid", idempotencyKey: key, ruleSnapshot: { ...rule, tierThreshold: tier.threshold }, reason: "tier_threshold_reached", createdAt: now, updatedAt: now,
      }).returning();
      if (created) await addRewardLedger(rewardId, "created", null, "بلوغ مستوى الإحالات", { threshold: tier.threshold }, now);
    } catch (error) { if (!/unique/i.test(String(error))) throw error; }
  }
}

async function qualifyAttribution(attributionId: string, event: ReferralQualificationEvent, paymentRequestId: string | null, now: Date): Promise<void> {
  const [attribution] = await db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.id, attributionId)).limit(1);
  if (!attribution || attribution.status === "blocked" || attribution.status === "cancelled" || attribution.reviewStatus === "pending" || attribution.reviewStatus === "rejected" || !attribution.emailVerifiedAt) return;
  const rule = asRule(attribution.ruleSnapshot);
  if (!rule || rule.qualificationEvent !== event) return;
  await db.update(referralAttributionsTable).set({ status: "qualified", updatedAt: now }).where(eq(referralAttributionsTable.id, attribution.id));
  await createReferrerReward(attribution, rule, event, paymentRequestId, now);
  if (rule.inviteeRewardType === "trial_extra_days" && rule.inviteeRewardValue > 0) {
    const key = `invitee-trial:${attribution.id}`;
    const [existing] = await db.select().from(referralRewardsTable).where(eq(referralRewardsTable.idempotencyKey, key)).limit(1);
    if (!existing) {
      const rewardId = id("refreward");
      const [reward] = await db.insert(referralRewardsTable).values({
        id: rewardId, attributionId: attribution.id, campaignId: attribution.campaignId, recipientUserId: attribution.invitedUserId, recipientRole: "invitee",
        rewardType: "trial_extra_days", rewardValue: rule.inviteeRewardValue, estimatedCost: rule.inviteeRewardCost, status: "eligible", qualificationEvent: event,
        idempotencyKey: key, ruleSnapshot: rule, reason: "qualified_trial_extension", createdAt: now, updatedAt: now,
      }).returning();
      if (reward) await addRewardLedger(rewardId, "created", null, "مستحقة لتمديد التجربة", {}, now);
    }
  }
  await createTierRewards(attribution, rule, now);
}

/** Called on email confirmation, trial start and admin-approved first payment. */
export async function recordReferralEvent(input: { userId: number; event: ReferralQualificationEvent; paymentRequestId?: string | null; now?: Date }): Promise<void> {
  const now = input.now || new Date();
  const [attribution] = await db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.invitedUserId, input.userId)).limit(1);
  if (!attribution || attribution.status === "blocked" || attribution.status === "cancelled") return;
  const set: Record<string, unknown> = { updatedAt: now };
  if (input.event === "email_verified" && !attribution.emailVerifiedAt) set.emailVerifiedAt = now;
  if (input.event === "trial_started" && !attribution.trialStartedAt) set.trialStartedAt = now;
  if (input.event === "first_paid" && !attribution.firstPaidAt) { set.firstPaidAt = now; set.paymentRequestId = input.paymentRequestId || null; }
  await db.update(referralAttributionsTable).set(set).where(eq(referralAttributionsTable.id, attribution.id));
  const [fresh] = await db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.id, attribution.id)).limit(1);
  if (!fresh) return;
  const rule = asRule(fresh.ruleSnapshot);
  if (!rule || fresh.reviewStatus === "pending" || fresh.reviewStatus === "rejected") return;
  /* No qualification may issue a reward until the invited email is confirmed.
   * Payment/trial events received early remain recorded and are replayed below
   * once the confirmation arrives, rather than losing a legitimate referral. */
  if (!fresh.emailVerifiedAt) {
    /* A qualification attempt before email confirmation is a deterministic
     * eligibility failure, not a network/device heuristic. Keep the reason
     * durable so staff and the referrer never see a phantom pending reward. */
    if (input.event !== "email_verified") await db.update(referralAttributionsTable).set({
      status: "blocked", reviewStatus: "rejected", blockedReason: "email_not_verified", reviewReason: "email_not_verified", updatedAt: now,
    }).where(eq(referralAttributionsTable.id, fresh.id));
    return;
  }
  if (input.event === "email_verified") await createInviteePurchaseReward(fresh, rule, now);
  let qualificationEvent: ReferralQualificationEvent = input.event;
  let qualificationPaymentId = input.paymentRequestId || null;
  if (input.event === "email_verified") {
    if (rule.qualificationEvent === "trial_started" && fresh.trialStartedAt) {
      qualificationEvent = "trial_started";
      qualificationPaymentId = null;
    } else if (rule.qualificationEvent === "first_paid" && fresh.firstPaidAt) {
      qualificationEvent = "first_paid";
      qualificationPaymentId = fresh.paymentRequestId || null;
    }
  }
  await qualifyAttribution(fresh.id, qualificationEvent, qualificationPaymentId, now);
  /* Non-payment qualification has no fraud hold by policy, so grant eligible
   * rewards now; the durable lifecycle worker remains the retry/backstop. */
  if (rule.qualificationEvent === qualificationEvent && !(qualificationEvent === "first_paid" && rule.holdDays > 0)) {
    const eligible = await db.select({ id: referralRewardsTable.id }).from(referralRewardsTable)
      .where(and(eq(referralRewardsTable.attributionId, fresh.id), eq(referralRewardsTable.status, "eligible")));
    for (const reward of eligible) await grantReferralReward(reward.id, null, "منح تلقائي بعد استيفاء الشرط", now);
  }
}

/** Used by /r/CODE. It does not expose whether a code is bad to the visitor. */
export async function resolveReferralLanding(codeValue: unknown, ip: string, now = new Date()): Promise<{ code: string | null; cookieDays: number; enabled: boolean; benefit: string | null }> {
  const settings = await readReferralSettings();
  const code = normalizeCode(codeValue);
  if (!settings.enabled || !code) return { code: null, cookieDays: settings.attributionCookieDays, enabled: settings.enabled, benefit: null };
  const resolved = await validCode(db, code, now);
  if (!resolved) return { code: null, cookieDays: settings.attributionCookieDays, enabled: settings.enabled, benefit: null };
  try {
    await db.insert(referralClickEventsTable).values({ id: id("refclick"), codeId: resolved.code.id, campaignId: resolved.campaign.id, visitorSignalHash: signalHash("click-ip", ip), createdAt: now });
  } catch { /* tracking cannot break a landing page */ }
  const rule = campaignRule(resolved.campaign, resolved.code.ruleOverride, now);
  const benefit = rule.inviteeRewardType === "trial_extra_days"
    ? `تجربة إضافية لمدة ${rule.inviteeRewardValue} يوم`
    : rule.inviteeRewardType === "first_subscription_percent"
      ? `خصم ${rule.inviteeRewardValue}% على أول اشتراك`
      : rule.inviteeRewardType === "first_subscription_amount"
        ? `خصم ${rule.inviteeRewardValue} جنيه على أول اشتراك`
        : "ميزة خاصة عند استيفاء شروط الحملة";
  return { code, cookieDays: settings.attributionCookieDays, enabled: true, benefit };
}

export function encodeReferralCookie(code: string): string {
  const secret = process.env["REFERRAL_COOKIE_SECRET"] || process.env["SESSION_SECRET"] || "referral-local-cookie-not-for-production";
  const sig = crypto.createHmac("sha256", secret).update(code).digest("base64url");
  return `${code}.${sig}`;
}

export function decodeReferralCookie(value: unknown): string | null {
  const raw = String(value || "");
  const [code, sig, extra] = raw.split(".");
  if (extra !== undefined || !code || !sig) return null;
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const expected = encodeReferralCookie(normalized).split(".")[1]!;
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? normalized : null; } catch { return null; }
}

/** The exact referral discount chosen for an authenticated user's payment. */
export async function resolveReferralPaymentDiscount(input: { userId: number; phone: string; price: number; now?: Date }): Promise<{ price: number; rewardId: string | null; couponId: number | null; discount: number; label: string | null }> {
  const now = input.now || new Date();
  const [approved] = await db.select({ id: paymentRequestsTable.id }).from(paymentRequestsTable)
    .where(and(eq(paymentRequestsTable.phone, input.phone), eq(paymentRequestsTable.status, "approved"))).limit(1);
  const coupons = await db.select().from(couponsTable)
    .where(and(eq(couponsTable.ownerUserId, input.userId), eq(couponsTable.autoApply, true), eq(couponsTable.isActive, true)));
  const candidates = coupons.filter((coupon) => {
    if (coupon.startsAt && coupon.startsAt.getTime() > now.getTime()) return false;
    if (coupon.expiresAt && coupon.expiresAt.getTime() <= now.getTime()) return false;
    if (coupon.maxUses !== null && (coupon.usedCount || 0) >= coupon.maxUses) return false;
    if (coupon.firstSubscriptionOnly && Boolean(approved)) return false;
    if (coupon.renewalOnly && !approved) return false;
    return true;
  });
  let best: { coupon: typeof coupons[number]; discount: number } | null = null;
  for (const coupon of candidates) {
    const discount = coupon.discountType === "percent" ? Math.floor(input.price * Math.min(100, Math.max(0, coupon.discountValue)) / 100) : Math.min(input.price, Math.max(0, coupon.discountValue));
    if (!best || discount > best.discount) best = { coupon, discount };
  }
  if (!best || best.discount <= 0) return { price: input.price, rewardId: null, couponId: null, discount: 0, label: null };
  const [reward] = best.coupon.referralRewardId ? await db.select({ id: referralRewardsTable.id }).from(referralRewardsTable).where(eq(referralRewardsTable.id, best.coupon.referralRewardId)).limit(1) : [];
  return { price: Math.max(1, input.price - best.discount), rewardId: reward?.id || null, couponId: best.coupon.id, discount: best.discount, label: "مكافأة إحالة مطبقة تلقائيًا" };
}

export async function reserveReferralPaymentDiscount(input: { rewardId: string | null; couponId: number | null; paymentRequestId: string; now?: Date }): Promise<void> {
  if (!input.rewardId || !input.couponId) return;
  const now = input.now || new Date();
  await db.update(referralRewardsTable).set({ paymentRequestId: input.paymentRequestId, updatedAt: now })
    .where(and(eq(referralRewardsTable.id, input.rewardId), inArray(referralRewardsTable.status, ["pending", "eligible", "granted"])));
}

async function grantVipDays(reward: typeof referralRewardsTable.$inferSelect, now: Date): Promise<Record<string, unknown>> {
  const days = reward.rewardValue;
  /* A live selected-scope trial must never become an all-feature paid row
   * early merely because a referral award was earned. Extend its current
   * server trial window instead; paid/non-trial awards use the normal
   * stack-after-expiry rule below. */
  const [liveTrial] = await db.select().from(userSubscriptionsTable).where(and(
    eq(userSubscriptionsTable.userId, reward.recipientUserId), eq(userSubscriptionsTable.subscriptionType, "trial"), eq(userSubscriptionsTable.status, "active"), gte(userSubscriptionsTable.expiresAt, now),
  )).limit(1);
  if (liveTrial) {
    const extension = await extendFreeTrial(reward.recipientUserId, days, now);
    if (extension.status !== "extended") throw new Error("Unable to extend live trial referral reward");
    return { days, extensionFrom: liveTrial.expiresAt.toISOString(), extensionTo: extension.endsAt?.toISOString() || null, appliedToTrial: true };
  }
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, reward.recipientUserId)).for("update").limit(1);
    const base = current && current.expiresAt.getTime() > now.getTime() ? current.expiresAt : now;
    const expiresAt = addCairoCalendarDays(base, days);
    const cycleId = `refbonus-${reward.recipientUserId}-${reward.id}`;
    if (current) {
      await tx.update(userSubscriptionsTable).set({
        subscriptionType: "paid", status: "active", cycleId, startsAt: current.expiresAt.getTime() > now.getTime() ? current.startsAt : now,
        expiresAt, graceEndsAt: null, source: "referral_bonus", cancelledAt: null, updatedAt: now,
      }).where(eq(userSubscriptionsTable.userId, reward.recipientUserId));
    } else {
      const [plan] = await tx.select().from(subscriptionPlansTable).where(eq(subscriptionPlansTable.isActive, true)).orderBy(asc(subscriptionPlansTable.price)).limit(1);
      await tx.insert(userSubscriptionsTable).values({
        id: `sub-referral-${reward.recipientUserId}`, userId: reward.recipientUserId, planKey: plan?.key || "referral-bonus",
        planNameAr: plan?.nameAr || "مكافأة إحالة VIP", planDurationMonths: 1, planFeatures: Array.isArray(plan?.features) ? plan.features : [],
        subscriptionType: "paid", status: "active", cycleId, startsAt: now, expiresAt, source: "referral_bonus", createdAt: now, updatedAt: now,
      });
    }
    await tx.update(appUsersTable).set({ plan: "vip", vipExpiresAt: expiresAt, updatedAt: now }).where(eq(appUsersTable.id, reward.recipientUserId));
    return { days, extensionFrom: base.toISOString(), extensionTo: expiresAt.toISOString() };
  });
}

async function ensureRewardCoupon(reward: typeof referralRewardsTable.$inferSelect, now: Date): Promise<Record<string, unknown>> {
  if (reward.couponId) return { couponId: reward.couponId, automatic: true };
  const rule = asRule(reward.ruleSnapshot);
  const type = reward.rewardType === "renewal_credit" ? "amount" : "percent";
  const couponCode = `R${crypto.randomBytes(7).toString("hex").toUpperCase()}`;
  const [coupon] = await db.insert(couponsTable).values({
    code: couponCode, discountType: type, discountValue: reward.rewardValue, maxUses: 1, usedCount: 0, isActive: true,
    ownerUserId: reward.recipientUserId, referralRewardId: reward.id, renewalOnly: reward.rewardType === "renewal_credit", autoApply: true, createdAt: now,
  }).returning();
  if (!coupon) throw new Error("Unable to create referral coupon");
  await db.update(referralRewardsTable).set({ couponId: coupon.id, updatedAt: now }).where(eq(referralRewardsTable.id, reward.id));
  return { couponId: coupon.id, automatic: true };
}

function rewardLabel(reward: Pick<typeof referralRewardsTable.$inferSelect, "rewardType" | "rewardValue">): string {
  if (reward.rewardType === "vip_days" || reward.rewardType === "trial_extra_days") return `${reward.rewardValue} يوم VIP`;
  if (reward.rewardType === "renewal_credit") return `رصيد خصم ${reward.rewardValue} جنيه`;
  if (reward.rewardType === "first_subscription_percent" || reward.rewardType === "coupon") return `خصم ${reward.rewardValue}%`;
  return `خصم ${reward.rewardValue} جنيه`;
}

export async function grantReferralReward(rewardId: string, actorEmployeeId: number | null = null, reason = "", now = new Date()): Promise<{ status: string; reward: typeof referralRewardsTable.$inferSelect | null }> {
  const [reward] = await db.select().from(referralRewardsTable).where(eq(referralRewardsTable.id, rewardId)).limit(1);
  if (!reward) return { status: "not_found", reward: null };
  if (reward.status === "granted") return { status: "already_granted", reward };
  if (["cancelled", "withdrawn"].includes(reward.status)) return { status: "cancelled", reward };
  if (reward.holdUntil && reward.holdUntil.getTime() > now.getTime()) return { status: "hold", reward };
  let snapshot: Record<string, unknown> = {};
  if (reward.rewardType === "vip_days") snapshot = await grantVipDays(reward, now);
  else if (reward.rewardType === "trial_extra_days") {
    const extended = await extendFreeTrial(reward.recipientUserId, reward.rewardValue, now);
    if (extended.status !== "extended") return { status: "not_eligible", reward };
    snapshot = { days: reward.rewardValue, endsAt: extended.endsAt?.toISOString() || null };
  } else if (["coupon", "renewal_credit"].includes(reward.rewardType)) snapshot = await ensureRewardCoupon(reward, now);
  else if (["first_subscription_percent", "first_subscription_amount"].includes(reward.rewardType)) {
    if (!reward.paymentRequestId) return { status: "not_eligible", reward };
    snapshot = { paymentRequestId: reward.paymentRequestId, appliedAt: now.toISOString() };
  }
  const [updated] = await db.update(referralRewardsTable).set({ status: "granted", grantedBy: actorEmployeeId, grantedAt: now, reason: reason || reward.reason, grantSnapshot: snapshot, updatedAt: now })
    .where(and(eq(referralRewardsTable.id, reward.id), inArray(referralRewardsTable.status, ["pending", "eligible"]))).returning();
  if (!updated) return { status: "race_lost", reward };
  await addRewardLedger(updated.id, "granted", actorEmployeeId, reason || null, snapshot, now);
  const [attr] = updated.attributionId ? await db.select({ invitedUserId: referralAttributionsTable.invitedUserId }).from(referralAttributionsTable).where(eq(referralAttributionsTable.id, updated.attributionId)).limit(1) : [];
  const [recipient] = await db.select({ name: appUsersTable.name }).from(appUsersTable).where(eq(appUsersTable.id, updated.recipientUserId)).limit(1);
  void deliverReferralMessage({ deliveryKey: `reward:${updated.id}`, recipientUserId: updated.recipientUserId, eventKey: "reward_granted", vars: { name: recipient?.name || "", reward: rewardLabel(updated), friend_name: attr ? "صديقك" : "", days: String(updated.rewardType === "vip_days" || updated.rewardType === "trial_extra_days" ? updated.rewardValue : "") }, now });
  return { status: "granted", reward: updated };
}

/** Durable worker path; schedules use the same Cairo-aware lifecycle runner. */
export async function runReferralLifecycle(options: { now?: Date; dryRun?: boolean } = {}): Promise<{ inspected: number; granted: number; cancelled: number }> {
  const now = options.now || new Date(), dryRun = options.dryRun === true;
  const candidates = await db.select().from(referralRewardsTable)
    .where(and(eq(referralRewardsTable.status, "pending"), or(isNull(referralRewardsTable.holdUntil), lte(referralRewardsTable.holdUntil, now))));
  let granted = 0, cancelled = 0;
  for (const reward of candidates) {
    if (reward.paymentRequestId) {
      const [payment] = await db.select({ status: paymentRequestsTable.status }).from(paymentRequestsTable).where(eq(paymentRequestsTable.id, reward.paymentRequestId)).limit(1);
      if (payment && ["rejected", "refunded", "cancelled"].includes(payment.status)) {
        if (!dryRun) await cancelReferralReward(reward.id, null, "تم إلغاء/استرجاع الدفع أثناء فترة الانتظار", now);
        cancelled += 1; continue;
      }
      if (!payment || payment.status !== "approved") continue;
    }
    if (!dryRun) {
      await db.update(referralRewardsTable).set({ status: "eligible", updatedAt: now }).where(and(eq(referralRewardsTable.id, reward.id), eq(referralRewardsTable.status, "pending")));
      await addRewardLedger(reward.id, "eligible", null, "انتهت فترة الانتظار", {}, now);
      const outcome = await grantReferralReward(reward.id, null, "منح تلقائي بعد فترة الانتظار", now);
      if (outcome.status === "granted") granted += 1;
    }
  }
  const eligible = await db.select({ id: referralRewardsTable.id }).from(referralRewardsTable).where(eq(referralRewardsTable.status, "eligible"));
  if (!dryRun) for (const item of eligible) { const outcome = await grantReferralReward(item.id, null, "منح تلقائي", now); if (outcome.status === "granted") granted += 1; }
  return { inspected: candidates.length, granted, cancelled };
}

export async function cancelReferralReward(rewardId: string, actorEmployeeId: number | null, reason: string, now = new Date()): Promise<boolean> {
  const [reward] = await db.update(referralRewardsTable).set({ status: "cancelled", cancelledBy: actorEmployeeId, cancelledAt: now, reason: cleanText(reason, 300), updatedAt: now })
    .where(and(eq(referralRewardsTable.id, rewardId), inArray(referralRewardsTable.status, ["pending", "eligible"]))).returning();
  if (!reward) return false;
  if (reward.couponId) await db.update(couponsTable).set({ isActive: false }).where(eq(couponsTable.id, reward.couponId));
  await addRewardLedger(reward.id, "cancelled", actorEmployeeId, cleanText(reason, 300), {}, now);
  return true;
}

export async function withdrawReferralReward(rewardId: string, actorEmployeeId: number | null, reason: string, now = new Date()): Promise<{ status: string }> {
  const [reward] = await db.select().from(referralRewardsTable).where(eq(referralRewardsTable.id, rewardId)).limit(1);
  if (!reward || reward.status !== "granted") return { status: "not_granted" };
  const snapshot = reward.grantSnapshot && typeof reward.grantSnapshot === "object" ? reward.grantSnapshot as Record<string, unknown> : {};
  let entitlementReversed = false;
  if (reward.rewardType === "vip_days" && typeof snapshot.extensionFrom === "string" && typeof snapshot.extensionTo === "string") {
    const from = new Date(snapshot.extensionFrom), to = new Date(snapshot.extensionTo);
    const [sub] = await db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, reward.recipientUserId)).limit(1);
    if (sub && Number.isFinite(from.getTime()) && Number.isFinite(to.getTime()) && sub.expiresAt.getTime() === to.getTime()) {
      await db.update(userSubscriptionsTable).set({ expiresAt: from, updatedAt: now }).where(eq(userSubscriptionsTable.userId, reward.recipientUserId));
      await db.update(appUsersTable).set({ vipExpiresAt: from, updatedAt: now }).where(eq(appUsersTable.id, reward.recipientUserId));
      entitlementReversed = true;
    }
  }
  if (reward.couponId) await db.update(couponsTable).set({ isActive: false }).where(eq(couponsTable.id, reward.couponId));
  await db.update(referralRewardsTable).set({ status: "withdrawn", cancelledBy: actorEmployeeId, cancelledAt: now, reason: cleanText(reason, 300), updatedAt: now,
    grantSnapshot: { ...snapshot, manualWithdrawal: true, entitlementReversed } }).where(eq(referralRewardsTable.id, reward.id));
  await addRewardLedger(reward.id, "withdrawn", actorEmployeeId, cleanText(reason, 300), { entitlementReversed }, now);
  return { status: entitlementReversed ? "withdrawn" : "withdrawn_recorded" };
}

/** Payment approval hook: runs after the payment/entitlement transaction and remains idempotent. */
export async function onReferralPaymentApproved(input: { userId: number; paymentRequestId: string; senderPhone?: string | null; proofHash?: string | null; now?: Date }): Promise<void> {
  const now = input.now || new Date();
  const [attribution] = await db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.invitedUserId, input.userId)).limit(1);
  if (!attribution || attribution.status === "blocked" || attribution.status === "cancelled") return;
  const [referrer] = attribution.referrerUserId ? await db.select({ phone: appUsersTable.phone }).from(appUsersTable).where(eq(appUsersTable.id, attribution.referrerUserId)).limit(1) : [];
  let suspicious = attribution.suspicious, reasons = attribution.reviewReason ? attribution.reviewReason.split(",").filter(Boolean) : [];
  if (input.senderPhone && referrer?.phone && input.senderPhone === referrer.phone) { suspicious = true; reasons.push("payment_sender_matches_referrer"); await addSignal(db, attribution.id, "payment_sender_matches_referrer", {}, now); }
  if (input.proofHash) {
    const [duplicate] = await db.select({ id: paymentRequestsTable.id }).from(paymentRequestsTable)
      .where(and(eq(paymentRequestsTable.proofHash, input.proofHash), ne(paymentRequestsTable.id, input.paymentRequestId))).limit(1);
    if (duplicate) { suspicious = true; reasons.push("duplicate_payment_proof"); await addSignal(db, attribution.id, "duplicate_payment_proof", {}, now); }
  }
  if (suspicious) {
    await db.update(referralAttributionsTable).set({ status: "review", reviewStatus: "pending", suspicious: true, reviewReason: [...new Set(reasons)].join(","), updatedAt: now }).where(eq(referralAttributionsTable.id, attribution.id));
    return;
  }
  await db.update(referralRewardsTable).set({ status: "granted", grantedAt: now, grantSnapshot: { paymentRequestId: input.paymentRequestId, appliedAt: now.toISOString() }, updatedAt: now })
    .where(and(eq(referralRewardsTable.paymentRequestId, input.paymentRequestId), inArray(referralRewardsTable.rewardType, ["first_subscription_percent", "first_subscription_amount"]), eq(referralRewardsTable.status, "pending")));
  const [inviteeReward] = await db.select().from(referralRewardsTable).where(and(eq(referralRewardsTable.paymentRequestId, input.paymentRequestId), inArray(referralRewardsTable.rewardType, ["first_subscription_percent", "first_subscription_amount"]))).limit(1);
  if (inviteeReward?.couponId) await db.update(couponsTable).set({ usedCount: sql`${couponsTable.usedCount} + 1`, isActive: false }).where(eq(couponsTable.id, inviteeReward.couponId));
  if (inviteeReward) await addRewardLedger(inviteeReward.id, "granted", null, "طُبق الخصم تلقائيًا على أول اشتراك", { paymentRequestId: input.paymentRequestId }, now);
  await recordReferralEvent({ userId: input.userId, event: "first_paid", paymentRequestId: input.paymentRequestId, now });
}

export async function onReferralPaymentCancelled(paymentRequestId: string, reason: string, now = new Date()): Promise<void> {
  const rewards = await db.select({ id: referralRewardsTable.id }).from(referralRewardsTable)
    .where(and(eq(referralRewardsTable.paymentRequestId, paymentRequestId), inArray(referralRewardsTable.status, ["pending", "eligible"])));
  for (const reward of rewards) await cancelReferralReward(reward.id, null, reason, now);
}

export async function approveReferralReview(attributionId: string, employeeId: number | null, now = new Date()): Promise<boolean> {
  const [attr] = await db.update(referralAttributionsTable).set({ reviewStatus: "approved", status: "registered", reviewedBy: employeeId, reviewedAt: now, updatedAt: now })
    .where(and(eq(referralAttributionsTable.id, attributionId), eq(referralAttributionsTable.reviewStatus, "pending"))).returning();
  if (!attr) return false;
  const rule = asRule(attr.ruleSnapshot);
  if (!rule) return false;
  if (attr.emailVerifiedAt) await createInviteePurchaseReward(attr, rule, now);
  if (attr.firstPaidAt) await qualifyAttribution(attr.id, "first_paid", attr.paymentRequestId, now);
  else if (attr.trialStartedAt) await qualifyAttribution(attr.id, "trial_started", null, now);
  else if (attr.emailVerifiedAt) await qualifyAttribution(attr.id, "email_verified", null, now);
  return true;
}

export async function rejectReferralReview(attributionId: string, employeeId: number | null, reason: string, now = new Date()): Promise<boolean> {
  const [attr] = await db.update(referralAttributionsTable).set({ reviewStatus: "rejected", status: "cancelled", reviewedBy: employeeId, reviewedAt: now, reviewReason: cleanText(reason, 300), updatedAt: now })
    .where(and(eq(referralAttributionsTable.id, attributionId), eq(referralAttributionsTable.reviewStatus, "pending"))).returning();
  if (!attr) return false;
  const rewards = await db.select({ id: referralRewardsTable.id }).from(referralRewardsTable).where(and(eq(referralRewardsTable.attributionId, attr.id), inArray(referralRewardsTable.status, ["pending", "eligible"])));
  for (const reward of rewards) await cancelReferralReward(reward.id, employeeId, cleanText(reason, 300), now);
  return true;
}

export async function publicReferralDashboard(userId: number, now = new Date()) {
  const [user, settings, code] = await Promise.all([
    db.select({ name: appUsersTable.name }).from(appUsersTable).where(eq(appUsersTable.id, userId)).limit(1).then((rows) => rows[0]),
    readReferralSettings(), ensureReferralCode(userId, now),
  ]);
  const attributions = await db.select({
    attribution: referralAttributionsTable,
    invitedName: appUsersTable.name,
    invitedEmail: appUsersTable.email,
  }).from(referralAttributionsTable).leftJoin(appUsersTable, eq(referralAttributionsTable.invitedUserId, appUsersTable.id))
    .where(eq(referralAttributionsTable.referrerUserId, userId)).orderBy(desc(referralAttributionsTable.createdAt)).limit(100);
  const rewards = await db.select().from(referralRewardsTable).where(eq(referralRewardsTable.recipientUserId, userId)).orderBy(desc(referralRewardsTable.createdAt)).limit(100);
  const friendDisplay = (name: string | null, email: string | null) => {
    const first = cleanText(name, 80).split(/\s+/)[0] || "";
    if (first) return first;
    const [local, domain] = String(email || "").split("@");
    return local && domain ? `${local.slice(0, 1)}***@${domain}` : "مستخدم جديد";
  };
  const starts = attributions.filter((row) => Boolean(row.attribution.trialStartedAt)).length;
  const paid = attributions.filter((row) => Boolean(row.attribution.firstPaidAt)).length;
  return {
    enabled: settings.enabled, termsText: settings.termsText, code: code.code, linkPath: `/r/${code.code}`,
    stats: { invited: attributions.length, registered: attributions.filter((row) => row.attribution.status !== "blocked").length, trials: starts, subscribers: paid,
      rewardsGranted: rewards.filter((row) => row.status === "granted").length, rewardsPending: rewards.filter((row) => ["pending", "eligible"].includes(row.status)).length },
    history: attributions.map((row) => ({ id: row.attribution.id, friend: friendDisplay(row.invitedName, row.invitedEmail), status: row.attribution.status, reviewStatus: row.attribution.reviewStatus, reason: row.attribution.reviewReason === "monthly_cap" ? "وصلت إلى سقف المكافآت الشهري" : row.attribution.reviewReason === "total_cap" ? "وصلت إلى سقف المكافآت الإجمالي" : null, createdAt: row.attribution.createdAt.toISOString(), trialStartedAt: row.attribution.trialStartedAt?.toISOString() || null, firstPaidAt: row.attribution.firstPaidAt?.toISOString() || null })), 
    rewards: rewards.map((row) => ({ id: row.id, type: row.rewardType, value: row.rewardValue, status: row.status, createdAt: row.createdAt.toISOString(), grantedAt: row.grantedAt?.toISOString() || null, holdUntil: row.holdUntil?.toISOString() || null, label: rewardLabel(row) })),
    name: user?.name || "",
  };
}

export async function adminReferralDashboard(now = new Date()) {
  const [settings, campaigns, codes, attributions, rewards, tiers, templates] = await Promise.all([
    readReferralSettings(), db.select().from(referralCampaignsTable).orderBy(desc(referralCampaignsTable.createdAt)),
    db.select().from(referralCodesTable).where(eq(referralCodesTable.kind, "special")).orderBy(desc(referralCodesTable.createdAt)),
    db.select().from(referralAttributionsTable).orderBy(desc(referralAttributionsTable.createdAt)).limit(500),
    db.select().from(referralRewardsTable).orderBy(desc(referralRewardsTable.createdAt)).limit(500),
    db.select().from(referralTiersTable).orderBy(asc(referralTiersTable.campaignId), asc(referralTiersTable.threshold)),
    db.select().from(referralMessageTemplatesTable).orderBy(asc(referralMessageTemplatesTable.eventKey)),
  ]);
  const messageTemplates = templates.length ? templates : referralMessageDefaults().map((template) => ({ id: `default-${template.eventKey}`, ...template, status: "active", version: 1, updatedBy: null, archivedAt: null, createdAt: now, updatedAt: now }));
  const referrerIds = [...new Set(attributions.map((item) => item.referrerUserId).filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0))];
  const [referrerUsers, normalCodes] = await Promise.all([
    referrerIds.length ? db.select({ id: appUsersTable.id, name: appUsersTable.name, phone: appUsersTable.phone, email: appUsersTable.email }).from(appUsersTable).where(inArray(appUsersTable.id, referrerIds)) : Promise.resolve([]),
    referrerIds.length ? db.select().from(referralCodesTable).where(and(inArray(referralCodesTable.ownerUserId, referrerIds), eq(referralCodesTable.kind, "user"))) : Promise.resolve([]),
  ]);
  const usersById = new Map(referrerUsers.map((user) => [user.id, user]));
  const codesByOwner = new Map(normalCodes.map((code) => [code.ownerUserId, code]));
  const referrers = referrerIds.map((userId) => {
    const entries = attributions.filter((item) => item.referrerUserId === userId), user = usersById.get(userId), code = codesByOwner.get(userId);
    const userRewards = rewards.filter((reward) => reward.recipientUserId === userId);
    return { userId, name: user?.name || "مستخدم", phone: user?.phone || "", code: code?.code || null, codeStatus: code?.status || "not_created", invited: entries.length, trials: entries.filter((item) => item.trialStartedAt).length, subscribers: entries.filter((item) => item.firstPaidAt).length, granted: userRewards.filter((reward) => reward.status === "granted").length, pending: userRewards.filter((reward) => ["pending", "eligible"].includes(reward.status)).length };
  }).sort((a, b) => b.subscribers - a.subscribers || b.invited - a.invited);
  const starts = attributions.filter((item) => item.trialStartedAt).length, subscribers = attributions.filter((item) => item.firstPaidAt).length;
  const [clickRows, revenueRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(referralClickEventsTable),
    db.select({ total: sql<number>`coalesce(sum(${paymentRequestsTable.price}), 0)` }).from(paymentRequestsTable)
      .innerJoin(referralAttributionsTable, eq(referralAttributionsTable.paymentRequestId, paymentRequestsTable.id)).where(eq(paymentRequestsTable.status, "approved")),
  ]);
  const clickRow = clickRows[0], revenueRow = revenueRows[0];
  const costRows = rewards.filter((reward) => reward.status === "granted");
  const knownCost = costRows.every((reward) => Number.isInteger(reward.estimatedCost));
  const cost = knownCost ? costRows.reduce((sum, reward) => sum + Number(reward.estimatedCost || 0), 0) : null;
  return { settings, campaigns, tiers, specialCodes: codes, templates: messageTemplates, attributions, rewards, referrers,
    stats: { clicks: Number(clickRow?.count || 0), registrations: attributions.filter((item) => item.status !== "blocked").length, trials: starts, subscribers,
      pendingReview: attributions.filter((item) => item.reviewStatus === "pending").length, revenue: Number(revenueRow?.total || 0), rewardCost: cost, costAvailable: knownCost, asOf: now.toISOString() } };
}

export async function saveReferralTemplate(eventKey: string, input: unknown, employeeId: number | null, now = new Date()) {
  if (!["friend_registered", "reward_granted"].includes(eventKey) || !input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>, titleTemplate = cleanText(v.titleTemplate, 160), bodyTemplate = cleanText(v.bodyTemplate, MAX_TEMPLATE_LENGTH);
  const channels = Array.isArray(v.channels) ? v.channels.map((x) => String(x)).filter((x) => ["in_app", "email"].includes(x)) : [];
  const status = String(v.status || "active");
  if (!titleTemplate || !bodyTemplate || !channels.length || !["active", "paused"].includes(status)) return null;
  const forbidden = /\{\{(?!name\}\}|reward\}\}|friend_name\}\}|days\}\})[^}]+\}\}/;
  if (forbidden.test(`${titleTemplate}\n${bodyTemplate}`)) return null;
  const [old] = await db.select().from(referralMessageTemplatesTable).where(eq(referralMessageTemplatesTable.eventKey, eventKey)).limit(1);
  const values = { id: old?.id || id("reftpl"), eventKey, channels, titleTemplate, bodyTemplate, status, version: (old?.version || 0) + 1, updatedBy: employeeId, updatedAt: now, archivedAt: null };
  const [saved] = await db.insert(referralMessageTemplatesTable).values({ ...values, createdAt: old?.createdAt || now })
    .onConflictDoUpdate({ target: referralMessageTemplatesTable.eventKey, set: values }).returning();
  return saved || null;
}

export async function createSpecialReferralCode(input: { code: unknown; label: unknown; ownerUserId?: unknown; campaignId?: unknown; ruleOverride?: unknown; expiresAt?: unknown; commissionDue?: unknown; commissionNotes?: unknown }, employeeId: number | null, now = new Date()) {
  const code = normalizeCode(input.code), label = cleanText(input.label, 100), ownerUserId = input.ownerUserId === undefined || input.ownerUserId === null || input.ownerUserId === "" ? null : Number(input.ownerUserId);
  if (!code || !label || (ownerUserId !== null && (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0))) return null;
  if (ownerUserId !== null) { const [owner] = await db.select({ id: appUsersTable.id }).from(appUsersTable).where(eq(appUsersTable.id, ownerUserId)).limit(1); if (!owner) return null; }
  let expiresAt: Date | null;
  try { expiresAt = parseCairoDateTime(input.expiresAt, "نهاية الكود الخاص"); } catch { return null; }
  const commissionDue = optionalInteger(input.commissionDue, 0, 1_000_000_000);
  if (commissionDue === null && input.commissionDue !== undefined && input.commissionDue !== "") return null;
  const campaignId = cleanText(input.campaignId, 100) || null;
  if (campaignId) { const [campaign] = await db.select({ id: referralCampaignsTable.id }).from(referralCampaignsTable).where(eq(referralCampaignsTable.id, campaignId)).limit(1); if (!campaign) return null; }
  const [created] = await db.insert(referralCodesTable).values({ id: id("refcode"), code, kind: "special", ownerUserId, campaignId, ruleOverride: input.ruleOverride && typeof input.ruleOverride === "object" && !Array.isArray(input.ruleOverride) ? input.ruleOverride as Record<string, unknown> : null, label, status: "active", expiresAt, commissionDue: commissionDue || 0, commissionNotes: cleanText(input.commissionNotes, 300) || null, createdBy: employeeId, updatedBy: employeeId, createdAt: now, updatedAt: now }).returning();
  return created || null;
}

export async function updateSpecialReferralCode(codeId: string, input: Record<string, unknown>, employeeId: number | null, now = new Date()) {
  const [existing] = await db.select().from(referralCodesTable).where(and(eq(referralCodesTable.id, codeId), eq(referralCodesTable.kind, "special"))).limit(1);
  if (!existing || existing.status === "archived") return null;
  const status = String(input.status || existing.status);
  if (!["active", "disabled"].includes(status)) return null;
  const code = input.code === undefined ? existing.code : normalizeCode(input.code);
  if (!code) return null;
  if (code !== existing.code) {
    const [collision] = await db.select({ id: referralCodesTable.id }).from(referralCodesTable).where(eq(referralCodesTable.code, code)).limit(1);
    if (collision) return null;
  }
  let expiresAt: Date | null;
  try { expiresAt = input.expiresAt === undefined ? existing.expiresAt : parseCairoDateTime(input.expiresAt, "نهاية الكود الخاص"); } catch { return null; }
  const commissionDue = input.commissionDue === undefined ? existing.commissionDue : optionalInteger(input.commissionDue, 0, 1_000_000_000);
  if (commissionDue === null) return null;
  const campaignId = input.campaignId === undefined ? existing.campaignId : cleanText(input.campaignId, 100) || null;
  if (campaignId) { const [campaign] = await db.select({ id: referralCampaignsTable.id }).from(referralCampaignsTable).where(eq(referralCampaignsTable.id, campaignId)).limit(1); if (!campaign) return null; }
  const ownerUserId = input.ownerUserId === undefined ? existing.ownerUserId : input.ownerUserId === null || input.ownerUserId === "" ? null : Number(input.ownerUserId);
  if (ownerUserId !== null && (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0)) return null;
  if (ownerUserId !== null) { const [owner] = await db.select({ id: appUsersTable.id }).from(appUsersTable).where(eq(appUsersTable.id, ownerUserId)).limit(1); if (!owner) return null; }
  const [updated] = await db.update(referralCodesTable).set({ code, label: input.label === undefined ? existing.label : cleanText(input.label, 100), status, campaignId, ownerUserId, expiresAt, commissionDue, commissionNotes: input.commissionNotes === undefined ? existing.commissionNotes : cleanText(input.commissionNotes, 300) || null, ruleOverride: input.ruleOverride === undefined ? existing.ruleOverride : input.ruleOverride && typeof input.ruleOverride === "object" && !Array.isArray(input.ruleOverride) ? input.ruleOverride as Record<string, unknown> : null, disabledAt: status === "disabled" ? now : null, updatedBy: employeeId, updatedAt: now }).where(eq(referralCodesTable.id, codeId)).returning();
  return updated || null;
}

export async function grantManualReferralReward(input: { userId: number; campaignId: string; rewardType: unknown; rewardValue: unknown; reason: unknown; actorEmployeeId: number | null; now?: Date }): Promise<{ status: string; rewardId?: string }> {
  const now = input.now || new Date();
  const type = rewardType(input.rewardType), value = Number(input.rewardValue);
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || !type || !Number.isSafeInteger(value) || value < 1) return { status: "invalid" };
  const [campaign] = await db.select().from(referralCampaignsTable).where(eq(referralCampaignsTable.id, input.campaignId)).limit(1);
  if (!campaign) return { status: "campaign_not_found" };
  const rewardId = id("refreward");
  const [reward] = await db.insert(referralRewardsTable).values({
    id: rewardId, campaignId: campaign.id, recipientUserId: input.userId, recipientRole: "manual", rewardType: type, rewardValue: value,
    status: "eligible", qualificationEvent: "first_paid", idempotencyKey: `manual:${rewardId}`, ruleSnapshot: campaignRule(campaign, null, now),
    reason: cleanText(input.reason, 300) || "منح يدوي", createdAt: now, updatedAt: now,
  }).returning();
  if (!reward) return { status: "failed" };
  await addRewardLedger(reward.id, "manual_created", input.actorEmployeeId, reward.reason, {}, now);
  const outcome = await grantReferralReward(reward.id, input.actorEmployeeId, reward.reason || "منح يدوي", now);
  return { status: outcome.status, rewardId };
}

export async function archiveSpecialReferralCode(codeId: string, employeeId: number | null, now = new Date()) {
  const [updated] = await db.update(referralCodesTable).set({ status: "archived", archivedAt: now, updatedBy: employeeId, updatedAt: now })
    .where(and(eq(referralCodesTable.id, codeId), eq(referralCodesTable.kind, "special"), ne(referralCodesTable.status, "archived"))).returning();
  return updated || null;
}

export async function setReferralUserProgramState(userId: number, action: "block" | "disable_code" | "regenerate_code", employeeId: number | null, now = new Date()): Promise<{ code?: string; status: string }> {
  if (action === "block") {
    const [updated] = await db.update(referralCodesTable).set({ status: "disabled", disabledAt: now, updatedBy: employeeId, updatedAt: now }).where(eq(referralCodesTable.ownerUserId, userId)).returning();
    return { status: updated ? "blocked" : "not_found" };
  }
  const code = await ensureReferralCode(userId, now);
  if (action === "disable_code") {
    await db.update(referralCodesTable).set({ status: "disabled", disabledAt: now, updatedBy: employeeId, updatedAt: now }).where(eq(referralCodesTable.id, code.id));
    return { status: "disabled" };
  }
  await db.update(referralCodesTable).set({ status: "archived", archivedAt: now, ownerUserId: null, updatedBy: employeeId, updatedAt: now }).where(eq(referralCodesTable.id, code.id));
  const fresh = await allocateReferralCode(userId, now);
  return { status: "regenerated", code: fresh.code };
}
