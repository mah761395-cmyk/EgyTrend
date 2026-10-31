/* ─── User wallet + auto-renewal: the financial core ─────────────────────
 *
 * Wallet rules (migration 0026):
 *   * the wallet is credited ONLY by explicit, admin-approved top-up
 *     requests — never automatically from any external payment method;
 *   * every credit/debit posts exactly one ledger row (the unique
 *     (ref_kind, ref_id) index is the authoritative double-operation guard);
 *   * a balance can never go negative: debits run inside a transaction that
 *     locks the wallet row and checks the balance before subtracting;
 *   * auto-renewal debits only happen for a row whose status is `active`
 *     (the user's explicit, still-consented state) — disabling only stops
 *     future debits; the current paid term always runs to its stored end.
 *
 * All amounts are integer EGP in the same unit as plan prices.
 * ═══════════════════════════════════════════════════════════════════════ */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  appUsersTable,
  subscriptionLifecycleEventsTable,
  subscriptionPlansTable,
  subscriptionRemindersSentTable,
  subscriptionRenewalsTable,
  userSubscriptionsTable,
  userWalletsTable,
  walletTransactionsTable,
} from "@workspace/db/schema";
import {
  calculateApprovedSubscriptionEnd,
  calculateSubscriptionGraceEnd,
  createSubscriptionCycleId,
  readSubscriptionLifecycleSettings,
} from "./subscription-lifecycle";
import { DAY_MS, formatCairoDate } from "./subscription-time";
import { insertDedupedNotification } from "./notifications";
import { logger } from "./logger";

export const WALLET_TOPUP_PLAN_KEY = "wallet_topup";
export const WALLET_TOPUP_MIN = 5;
export const WALLET_TOPUP_MAX = 5000;

/** How long past the stored term end (or grace end) a funded renewal is still
 * accepted. Covers cron cadence and short outages without letting ancient
 * slots debit unexpectedly. */
export const RENEWAL_LATE_WINDOW_MS = 7 * DAY_MS;

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A scoped test clock keeps production cycle time authoritative while
 * regression tests exercise exact renewal boundaries. */
export function renewalsCycleNow(): Date {
  const injected = process.env.NODE_ENV === "test"
    ? (globalThis as typeof globalThis & { __egytrendTestClock?: Date }).__egytrendTestClock
    : undefined;
  return injected instanceof Date && Number.isFinite(injected.getTime()) ? new Date(injected) : new Date();
}

/* ── Wallet helpers ─────────────────────────────────────────────────────── */

/** Lock (or create) the caller's wallet row inside an existing transaction. */
export async function lockWalletInTx(tx: DbTx, user: { id: number; phone: string }, now = new Date()) {
  const [row] = await tx
    .select()
    .from(userWalletsTable)
    .where(eq(userWalletsTable.userId, user.id))
    .for("update")
    .limit(1);
  if (row) return { userId: user.id, phone: user.phone, balance: row.balance };
  await tx.insert(userWalletsTable).values({ userId: user.id, phone: user.phone, balance: 0, createdAt: now, updatedAt: now });
  return { userId: user.id, phone: user.phone, balance: 0 };
}

export type WalletCreditResult =
  | { ok: true; balanceAfter: number }
  | { ok: false; reason: "duplicate_ref" };

/**
 * Post one wallet CREDIT (kind "topup"). The ledger's unique (ref_kind,
 * ref_id) index makes a double credit impossible even under concurrent
 * admin clicks: the second posting is a no-op conflict, detected here.
 */
export async function creditWalletInTx(
  tx: DbTx,
  input: { user: { id: number; phone: string }; amount: number; refKind: string; refId: string; note?: string | null },
  now = new Date(),
): Promise<WalletCreditResult> {
  const wallet = await lockWalletInTx(tx, input.user, now);
  const balanceAfter = wallet.balance + input.amount;
  const posted = await tx
    .insert(walletTransactionsTable)
    .values({
      id: `wtx-${input.refKind}-${input.refId}`,
      userId: input.user.id,
      phone: input.user.phone,
      kind: "topup",
      amount: input.amount,
      balanceAfter,
      refKind: input.refKind,
      refId: input.refId,
      note: input.note ?? null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: walletTransactionsTable.id });
  if (!posted.length) return { ok: false, reason: "duplicate_ref" };
  await tx
    .update(userWalletsTable)
    .set({ balance: balanceAfter, updatedAt: now })
    .where(eq(userWalletsTable.userId, input.user.id));
  return { ok: true, balanceAfter };
}

/* ── Auto-renewal consent ───────────────────────────────────────────────── */

export type RenewalConsentResult =
  | { ok: true }
  | { ok: false; reason: "no_active_subscription" | "plan_unavailable" };

/**
 * Record (or re-record) the user's explicit consent to auto-renew from the
 * wallet. Requires a live paid term (active or in grace) and an active plan
 * with a valid base price. `nextRenewalAt` is the CURRENT term's stored end:
 * the first scheduled debit happens when that term is due to end.
 */
export async function setAutoRenewalConsent(
  userId: number,
  phone: string,
  source: "checkout" | "settings",
  now = new Date(),
): Promise<RenewalConsentResult> {
  const [sub] = await db
    .select()
    .from(userSubscriptionsTable)
    .where(eq(userSubscriptionsTable.userId, userId))
    .limit(1);
  if (!sub || sub.subscriptionType !== "paid" || sub.status === "cancelled") {
    return { ok: false, reason: "no_active_subscription" };
  }
  const paidActive = sub.status === "active" && sub.expiresAt.getTime() > now.getTime();
  const graceActive =
    (sub.status === "active" || sub.status === "grace") &&
    sub.expiresAt.getTime() <= now.getTime() &&
    Boolean(sub.graceEndsAt && sub.graceEndsAt.getTime() > now.getTime());
  if (!paidActive && !graceActive) return { ok: false, reason: "no_active_subscription" };

  const [plan] = await db
    .select()
    .from(subscriptionPlansTable)
    .where(and(eq(subscriptionPlansTable.key, sub.planKey), eq(subscriptionPlansTable.isActive, true)))
    .limit(1);
  if (!plan || !Number.isSafeInteger(plan.price) || plan.price <= 0) {
    return { ok: false, reason: "plan_unavailable" };
  }

  const setValues = {
    phone,
    planKey: sub.planKey,
    planNameAr: sub.planNameAr,
    planDurationMonths: sub.planDurationMonths,
    /* Display snapshot only; the debit amount is always the plan's current
     * server price at renewal time. */
    lastKnownPrice: plan.price,
    status: "active" as const,
    nextRenewalAt: sub.expiresAt,
    consentAt: now,
    consentSource: source,
    disabledAt: null,
    lastAttemptResult: null,
    updatedAt: now,
  };
  /* `user_id` is the conflict target — it must stay out of SET. */
  await db
    .insert(subscriptionRenewalsTable)
    .values({ id: `renew-${userId}`, userId, createdAt: now, ...setValues })
    .onConflictDoUpdate({ target: subscriptionRenewalsTable.userId, set: setValues });
  return { ok: true };
}

/**
 * Disable auto-renewal. Deliberately touches NOTHING else: the current paid
 * term keeps running to its stored end — disabling only stops future debits.
 */
export async function disableAutoRenewal(userId: number, now = new Date()): Promise<boolean> {
  const updated = await db
    .update(subscriptionRenewalsTable)
    .set({
      status: "disabled",
      disabledAt: now,
      nextRenewalAt: null,
      updatedAt: now,
    })
    .where(and(eq(subscriptionRenewalsTable.userId, userId), eq(subscriptionRenewalsTable.status, "active")))
    .returning({ id: subscriptionRenewalsTable.id });
  return updated.length > 0;
}

/* ── The renewal runner (cron) ──────────────────────────────────────────── */

export type RenewalsCycleResult = {
  scanned: number;
  upcomingNotified: number;
  renewed: number;
  insufficient: number;
  failed: number;
  expired: number;
};

type DueRenewalOutcome =
  | "renewed"
  | "insufficient_balance"
  | "plan_unavailable"
  | "no_active_subscription"
  | "expired"
  | "already_posted";

async function recordAttempt(tx: DbTx, renewal: { userId: number; id: string }, result: DueRenewalOutcome, now: Date) {
  await tx
    .update(subscriptionRenewalsTable)
    .set({ lastAttemptAt: now, lastAttemptResult: result, updatedAt: now })
    .where(eq(subscriptionRenewalsTable.userId, renewal.userId));
}

/**
 * One renewal slot, executed atomically: plan price read → user locked →
 * subscription locked → wallet locked → balance check → ledger posting (the
 * unique ref index is the double-debit guard) → term extension → projection.
 * Any failure posts NO money and only records the attempt.
 */
async function processDueRenewal(
  renewal: typeof subscriptionRenewalsTable.$inferSelect,
  now: Date,
): Promise<DueRenewalOutcome> {
  const slotMs = renewal.nextRenewalAt ? renewal.nextRenewalAt.getTime() : 0;
  const slotRef = `slot-${renewal.userId}-${slotMs}`;

  return db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(subscriptionPlansTable)
      .where(and(eq(subscriptionPlansTable.key, renewal.planKey), eq(subscriptionPlansTable.isActive, true)))
      .limit(1);
    if (!plan || !Number.isSafeInteger(plan.price) || plan.price <= 0) {
      await recordAttempt(tx, renewal, "plan_unavailable", now);
      return "plan_unavailable";
    }

    const [user] = await tx
      .select({ id: appUsersTable.id, phone: appUsersTable.phone, status: appUsersTable.status })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, renewal.userId))
      .for("update")
      .limit(1);
    if (!user || user.status !== "active") {
      await recordAttempt(tx, renewal, "no_active_subscription", now);
      return "no_active_subscription";
    }

    const [sub] = await tx.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user.id)).for("update").limit(1);
    if (!sub || sub.subscriptionType !== "paid" || sub.status === "cancelled") {
      await recordAttempt(tx, renewal, "no_active_subscription", now);
      return "no_active_subscription";
    }
    /* The slot is due at the term's stored end. A funded renewal is accepted
     * up to LATE_WINDOW past (graceEndsAt ?? expiresAt) — the same
     * post-expiry rule admin approvals follow (the new term then starts from
     * the approval moment). Beyond the window the slot is terminal. */
    const windowEnd = (sub.graceEndsAt ?? sub.expiresAt).getTime() + RENEWAL_LATE_WINDOW_MS;
    if (now.getTime() > windowEnd) {
      await tx
        .update(subscriptionRenewalsTable)
        .set({ status: "expired", nextRenewalAt: null, lastAttemptAt: now, lastAttemptResult: "expired", updatedAt: now })
        .where(eq(subscriptionRenewalsTable.userId, user.id));
      return "expired";
    }
    const paidActive = sub.status === "active" && sub.expiresAt.getTime() > now.getTime();

    const wallet = await lockWalletInTx(tx, user, now);
    if (wallet.balance < plan.price) {
      /* Insufficient balance: NOTHING is debited. The slot stays scheduled so
       * a later top-up inside the window can still fund the renewal; the
       * notification is deduplicated to one per slot. */
      await recordAttempt(tx, renewal, "insufficient_balance", now);
      return "insufficient_balance";
    }

    const balanceAfter = wallet.balance - plan.price;
    const posted = await tx
      .insert(walletTransactionsTable)
      .values({
        id: `wtx-auto-renewal-${slotRef}`,
        userId: user.id,
        phone: user.phone,
        kind: "renewal_debit",
        amount: plan.price,
        balanceAfter,
        refKind: "auto_renewal",
        refId: slotRef,
        note: `تجديد تلقائي: ${sub.planNameAr}`,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: walletTransactionsTable.id });
    if (posted.length) {
      await tx
        .update(userWalletsTable)
        .set({ balance: balanceAfter, updatedAt: now })
        .where(eq(userWalletsTable.userId, user.id));
    } else {
      /* A concurrent execution already posted this slot: its debit already
       * reduced the balance, so the balance is left untouched here. The term
       * extension below is the same deterministic computation and stays
       * correct; the ledger remains single-posted. */
      logger.warn({ userId: user.id, slotRef }, "renewal slot already posted; skipping double debit");
    }

    /* Extend the term exactly like an admin-approved renewal: a live term
     * stacks from its stored end; a grace-period renewal starts from now. */
    const lifecycle = await readSubscriptionLifecycleSettings();
    const base = paidActive ? sub.expiresAt : now;
    const newExpires = calculateApprovedSubscriptionEnd(base, sub.planDurationMonths);
    const newGrace = calculateSubscriptionGraceEnd(newExpires, lifecycle.graceDays);
    const cycleId = createSubscriptionCycleId(user.id, slotRef);
    const subscriptionId = sub.id || `sub-${user.id}`;

    if (sub.cycleId) {
      await tx
        .update(subscriptionRemindersSentTable)
        .set({ emailStatus: "cancelled", emailNextAttemptAt: null, cancelledAt: now, updatedAt: now })
        .where(and(
          eq(subscriptionRemindersSentTable.subscriptionCycleId, sub.cycleId),
          inArray(subscriptionRemindersSentTable.emailStatus, ["pending", "sending"]),
        ));
      await tx
        .update(subscriptionRemindersSentTable)
        .set({ deliveryStatus: "cancelled", emailStatus: "cancelled", emailNextAttemptAt: null, cancelledAt: now, updatedAt: now })
        .where(and(
          eq(subscriptionRemindersSentTable.subscriptionCycleId, sub.cycleId),
          eq(subscriptionRemindersSentTable.deliveryStatus, "queued"),
        ));
    }

    const subValues = {
      planKey: sub.planKey,
      planNameAr: sub.planNameAr,
      planDurationMonths: sub.planDurationMonths,
      planFeatures: sub.planFeatures,
      subscriptionType: "paid" as const,
      status: "active" as const,
      cycleId,
      startsAt: paidActive ? sub.startsAt : now,
      expiresAt: newExpires,
      graceEndsAt: newGrace,
      paymentRequestId: null,
      source: "payment" as const,
      cancelledAt: null,
      updatedAt: now,
    };
    await tx
      .insert(userSubscriptionsTable)
      .values({ id: subscriptionId, userId: user.id, createdAt: now, ...subValues })
      .onConflictDoUpdate({ target: userSubscriptionsTable.userId, set: subValues });

    await tx
      .insert(subscriptionRenewalsTable)
      .values({
        id: `renew-${user.id}`,
        userId: user.id,
        phone: user.phone,
        planKey: sub.planKey,
        planNameAr: sub.planNameAr,
        planDurationMonths: sub.planDurationMonths,
        lastKnownPrice: plan.price,
        status: "active",
        nextRenewalAt: newExpires,
        lastRenewedAt: now,
        lastRenewalRef: posted.length ? slotRef : null,
        consentAt: renewal.consentAt,
        consentSource: renewal.consentSource,
        disabledAt: null,
        lastAttemptAt: now,
        lastAttemptResult: "ok",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: subscriptionRenewalsTable.userId,
        set: {
          lastKnownPrice: plan.price,
          status: "active",
          nextRenewalAt: newExpires,
          lastRenewedAt: now,
          lastRenewalRef: posted.length ? slotRef : renewal.lastRenewalRef,
          lastAttemptAt: now,
          lastAttemptResult: "ok",
          updatedAt: now,
        },
      });

    /* Compatibility projection (authorization reads user_subscriptions). */
    await tx
      .update(appUsersTable)
      .set({ plan: "vip", vipExpiresAt: newExpires, updatedAt: now })
      .where(eq(appUsersTable.id, user.id));

    /* Lifecycle event: the extension is recorded like every other one. */
    await tx
      .insert(subscriptionLifecycleEventsTable)
      .values({
        id: `subevent-${slotRef}`,
        userId: user.id,
        subscriptionId,
        subscriptionCycleId: cycleId,
        eventType: "renewed",
        relatedCycleId: sub.cycleId || null,
        planKey: sub.planKey,
        occurredAt: now,
        createdAt: now,
      })
      .onConflictDoNothing();

    return "renewed";
  });
}

/**
 * The scheduled cycle: (1) one pre-renewal notification per slot inside the
 * 3-day window, (2) execute every due slot. Deduplication is ref-key based,
 * so a repeated run never double-notifies or double-debits.
 */
export async function runRenewalsCycle(now = new Date()): Promise<RenewalsCycleResult> {
  const result: RenewalsCycleResult = { scanned: 0, upcomingNotified: 0, renewed: 0, insufficient: 0, failed: 0, expired: 0 };
  const rows = await db.select().from(subscriptionRenewalsTable).where(eq(subscriptionRenewalsTable.status, "active"));
  for (const renewal of rows) {
    if (!renewal.nextRenewalAt) continue;
    result.scanned += 1;
    const slotMs = renewal.nextRenewalAt.getTime();
    const msUntil = slotMs - now.getTime();

    if (msUntil > 0 && msUntil <= 3 * DAY_MS) {
      const sent = await insertDedupedNotification({
        phone: renewal.phone,
        kind: "renewal_upcoming",
        refKey: `pre:${renewal.userId}:${slotMs}`,
        title: "⏰ تجديد تلقائي خلال أيام",
        body: `سيُجدَّد اشتراكك «${renewal.planNameAr}» تلقائيًا بتاريخ ${formatCairoDate(renewal.nextRenewalAt)} مع خصم ${renewal.lastKnownPrice > 0 ? `${renewal.lastKnownPrice} جنيه` : "سعر الباقة"} من رصيد محفظتك عند الموعد. يمكنك إيقاف التجديد التلقائي في أي وقت من صفحة اشتراكك قبل الخصم.`,
        actionUrl: "/vip",
        actionLabel: "إدارة الاشتراك",
      });
      if (sent) result.upcomingNotified += 1;
    }

    if (now.getTime() >= slotMs) {
      const outcome = await processDueRenewal(renewal, now);
      if (outcome === "renewed" || outcome === "already_posted") {
        result.renewed += 1;
        await insertDedupedNotification({
          phone: renewal.phone,
          kind: "renewal_done",
          refKey: `done:${renewal.userId}:${slotMs}`,
          title: "✅ تم التجديد التلقائي",
          body: `تم تجديد اشتراكك «${renewal.planNameAr}» تلقائيًا وخصم المبلغ من رصيد محفظتك. تتابع المدة الجديدة من نهايتها السابقة.`,
          actionUrl: "/vip",
          actionLabel: "عرض اشتراكي",
        });
      } else if (outcome === "insufficient_balance") {
        result.insufficient += 1;
        await insertDedupedNotification({
          phone: renewal.phone,
          kind: "renewal_failed",
          refKey: `fail:${renewal.userId}:${slotMs}`,
          title: "⚠️ تعذر التجديد التلقائي",
          body: `لم يكفِ رصيد محفظتك لخصم قيمة تجديد «${renewal.planNameAr}» بتاريخ ${formatCairoDate(new Date(slotMs))}. لم يُخصم أي مبلغ. اشحن محفظتك قبل انتهاء مدة اشتراكك ليُعاد التجديد تلقائيًا، أو أوقف التجديد من صفحة اشتراكك.`,
          actionUrl: "/vip",
          actionLabel: "شحن المحفظة",
        });
      } else if (outcome === "expired") {
        result.expired += 1;
        await insertDedupedNotification({
          phone: renewal.phone,
          kind: "renewal_failed",
          refKey: `fail:${renewal.userId}:${slotMs}`,
          title: "⚠️ انتهى اشتراكك دون تجديد",
          body: `انتهت مدة اشتراكك «${renewal.planNameAr}» دون خصم تجديد كافٍ، وأُوقف التجديد التلقائي. يمكنك الاشتراك من جديد في أي وقت.`,
          actionUrl: "/vip",
          actionLabel: "الاشتراك",
        });
      } else {
        /* plan_unavailable / no_active_subscription: retried on the next
         * scheduled run; notify once per slot so a transient state does not
         * spam the user. */
        result.failed += 1;
        await insertDedupedNotification({
          phone: renewal.phone,
          kind: "renewal_failed",
          refKey: `fail:${renewal.userId}:${slotMs}`,
          title: "⚠️ تعذر تنفيذ التجديد التلقائي",
          body: `لم يمكن تنفيذ التجديد التلقائي لـ«${renewal.planNameAr}» الآن (الباقة غير متاحة مؤقتًا). لم يُخصم أي مبلغ وسنعيد المحاولة تلقائيًا.`,
          actionUrl: "/vip",
          actionLabel: "عرض اشتراكي",
        });
      }
    }
  }
  return result;
}
