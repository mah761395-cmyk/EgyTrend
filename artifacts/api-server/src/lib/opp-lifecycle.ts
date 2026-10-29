/**
 * Opportunity lifecycle (TASK M, M4) — pure evaluation, no I/O.
 *
 * A signal card is born "active". It then moves exactly once to a terminal
 * state, computed only from verified live prices:
 *
 *   target_hit       live price reached target 1   → status "realized"
 *   stop_hit         live price broke the stop     → status "expired"
 *   expired_by_time  the 10-day observation window closed with no result
 *
 * Rows are never deleted — the status, the result and the realized time are
 * what keep the history honest. If no live price is available, the card
 * stays where it is (we never infer an outcome from silence).
 */

import type { OpportunitySignal } from "./opp-signals";

export type OppLifecycleResult = "target_hit" | "stop_hit" | "expired_by_time";

export type OppLifecycleVerdict = {
  status: "active" | "realized" | "expired";
  result: OppLifecycleResult | null;
  /** Epoch ms when the terminal state was crossed (null while active). */
  realizedAt: number | null;
  /** One-line Arabic explanation for the card. */
  noteAr: string;
};

const MAX_ACTIVE_MS = 10 * 86_400_000;

export function evaluateOppLifecycle(
  signal: Pick<OpportunitySignal, "stopLoss" | "targets" | "entry">,
  livePrice: number | null,
  now: number,
  createdAt: number,
): OppLifecycleVerdict {
  /* Verified price crossings win, even on an old card: a target that was
   * actually reached is still a realized result. */
  if (livePrice !== null && Number.isFinite(livePrice) && livePrice > 0) {
    if (livePrice >= signal.targets.t1) {
      return {
        status: "realized",
        result: "target_hit",
        realizedAt: now,
        noteAr: `تحقق الهدف الأول: السعر بلغ ${signal.targets.t1} (الدخول ${signal.entry.low}–${signal.entry.high}).`,
      };
    }
    if (livePrice <= signal.stopLoss) {
      return {
        status: "expired",
        result: "stop_hit",
        realizedAt: now,
        noteAr: `كُسِر الوقف: السعر هبط إلى ${livePrice} (الوقف ${signal.stopLoss}) — الفكرة ملغاة والخسارة محصورة.`,
      };
    }
  }
  /* Time: an old card without a verifiable crossing is expired. */
  if (now - createdAt > MAX_ACTIVE_MS) {
    return {
      status: "expired",
      result: "expired_by_time",
      realizedAt: now,
      noteAr: "انتهت نافذة الملاحظة (10 أيام) دون تحقيق هدف أو كسر وقف.",
    };
  }
  if (livePrice === null || !Number.isFinite(livePrice) || livePrice <= 0) {
    return {
      status: "active",
      result: null,
      realizedAt: null,
      noteAr: "لا يوجد سعر حي حاليًا — الحالة كما هي حتى يظهر سعر موثق.",
    };
  }
  return {
    status: "active",
    result: null,
    realizedAt: null,
    noteAr: "النموذج ساري: السعر بين الوقف والهدف الأول.",
  };
}
