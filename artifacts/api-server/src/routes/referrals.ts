import { Router, type Request, type Response } from "express";
import { encodeReferralCookie, resolveReferralLanding } from "../lib/referrals";

const router = Router();
export const REFERRAL_COOKIE_NAME = "egytrend_referral";

/** Public link limiter. Every body is intentionally identical: the only
 * successful-attribution side effect is a silent HttpOnly cookie. */
const hits = new Map<string, { count: number; resetAt: number }>();
function limited(key: string, max = 30, windowMs = 10 * 60_000): boolean {
  const now = Date.now(), current = hits.get(key);
  if (!current || current.resetAt <= now) { hits.set(key, { count: 1, resetAt: now + windowMs }); return false; }
  current.count += 1;
  if (hits.size > 5_000) for (const [entryKey, entry] of hits) if (entry.resetAt <= now) hits.delete(entryKey);
  return current.count > max;
}

function genericLandingResponse(res: Response): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  /* Do not add a validity flag, benefit, expiry, retry marker, or a distinct
   * error/status. The client may safely render neutral invitation copy for all
   * cases, while the registration endpoint decides attribution server-side. */
  res.json({ status: "ok", invitation: { message: "لديك دعوة من صديق على EgyTrend. أكمل التسجيل للاستفادة من أي ميزة مستحقة وفق الشروط." } });
}

router.get("/landing/:code", async (req: Request, res: Response) => {
  const ip = req.ip || "unknown";
  if (limited(`landing:${ip}`)) {
    genericLandingResponse(res);
    return;
  }
  try {
    const result = await resolveReferralLanding(req.params["code"], ip, new Date());
    if (result.code) {
      /* This is deliberately the sole valid-code signal. It is HttpOnly and
       * consumed only during new-account registration; its content is never
       * reflected in JSON, UI state, or an error message. */
      res.cookie(REFERRAL_COOKIE_NAME, encodeReferralCookie(result.code), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: result.cookieDays * 24 * 60 * 60 * 1000,
      });
    }
  } catch {
    /* Tracking/database errors must be indistinguishable from a bad code. */
  }
  genericLandingResponse(res);
});

export default router;
