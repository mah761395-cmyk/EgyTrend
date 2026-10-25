import crypto from "crypto";

/** HMAC helpers shared by the consent route and the trial sequence outbox.
 * A marketing message must never be sent without a working unsubscribe URL. */
export function createMarketingUnsubscribeToken(userId: number, expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000): string | null {
  const secret = process.env["SESSION_SECRET"];
  if (!secret || !Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(expiresAt)) return null;
  const payload = `${userId}.${expiresAt}`;
  const signature = crypto.createHmac("sha256", secret).update(`marketing-unsubscribe:${payload}`).digest("hex");
  return `${payload}.${signature}`;
}

export function createMarketingUnsubscribeUrl(userId: number, appBaseUrl = process.env["APP_BASE_URL"]): string | null {
  const token = createMarketingUnsubscribeToken(userId);
  if (!token || !appBaseUrl) return null;
  try {
    const base = new URL(appBaseUrl);
    if (base.protocol !== "https:" || base.username || base.password) return null;
    return new URL(`/api/user/unsubscribe-marketing?token=${encodeURIComponent(token)}`, base).toString();
  } catch {
    return null;
  }
}

export function validMarketingUnsubscribeToken(value: unknown): { userId: number } | null {
  const token = String(value || "").trim();
  const match = /^(\d{1,10})\.(\d{10,13})\.([a-f0-9]{64})$/i.exec(token);
  const secret = process.env["SESSION_SECRET"];
  if (!match || !secret) return null;
  const userId = Number(match[1]);
  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  const payload = `${userId}.${expiresAt}`;
  const expected = crypto.createHmac("sha256", secret).update(`marketing-unsubscribe:${payload}`).digest("hex");
  const supplied = Buffer.from(match[3]!, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (supplied.length !== expectedBuffer.length || !crypto.timingSafeEqual(supplied, expectedBuffer)) return null;
  return { userId };
}
