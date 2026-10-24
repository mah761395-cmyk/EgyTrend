/**
 * The decision half of `POST /api/user/login`, kept separate from Express and
 * from the database so it can be tested without either.
 *
 * Order matters:
 *   1. shape validation (cheap, no oracle)
 *   2. attempt limit  — checked BEFORE any password work, so a blocked attacker
 *      cannot burn CPU on scrypt, and replayed requests cannot slip through
 *   3. credential check — one generic message for "no such user" and "wrong
 *      password", and a dummy hash comparison when the user does not exist so
 *      the two cases cost the same time
 *   4. success clears the per-account counter (a shared carrier IP recovers as
 *      soon as somebody authenticates from it)
 */
import crypto from "crypto";
import { LIMITS, type AttemptStore } from "./rate-limit";
import { checkUserPassword, hashUserPassword, normalizeUserPhone } from "./userAuth";

export type LoginUser = {
  id: number;
  phone: string;
  name: string;
  plan: string;
  vipExpiresAt: Date | null;
  status: string;
  passwordHash: string;
};

export type LoginOutcome =
  | { kind: "ok"; user: LoginUser }
  | { kind: "invalid"; status: 400 | 401; message: string }
  | { kind: "limited"; retryAfterSec: number };

export type LoginDeps = {
  findUser(phone: string): Promise<LoginUser | null>;
  store: AttemptStore;
  verifyPassword?: (password: string, encoded: string) => boolean;
};

/** Used for the "no such account" branch so it costs the same as a real check. */
const DUMMY_HASH = hashUserPassword(crypto.randomBytes(18).toString("hex"));

export function phoneBucket(phone: string): string {
  return `login:phone:${phone}`;
}

export function ipBucket(ip: string): string {
  return `login:ip:${ip}`;
}

export async function evaluateLogin(
  input: { phone: unknown; password: unknown; ip: string },
  deps: LoginDeps,
): Promise<LoginOutcome> {
  const phone = normalizeUserPhone(input.phone);
  const password = String(input.password ?? "");
  if (!phone || !password) {
    return { kind: "invalid", status: 400, message: "phone and password required" };
  }

  const verify = deps.verifyPassword ?? checkUserPassword;
  const ip = input.ip || "unknown";

  const [byPhone, byIp] = await Promise.all([
    deps.store.isBlocked(phoneBucket(phone), LIMITS.userPhone.limit, LIMITS.userPhone.windowMs),
    deps.store.isBlocked(ipBucket(ip), LIMITS.userIp.limit, LIMITS.userIp.windowMs),
  ]);
  if (byPhone.blocked || byIp.blocked) {
    return {
      kind: "limited",
      retryAfterSec: Math.max(byPhone.retryAfterSec, byIp.retryAfterSec, 1),
    };
  }

  const user = await deps.findUser(phone);
  /* Always run one scrypt comparison, whether the account exists or not. */
  const matches = verify(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !matches || user.status !== "active") {
    await Promise.all([
      deps.store.recordFailure(phoneBucket(phone), LIMITS.userPhone.limit, LIMITS.userPhone.windowMs),
      deps.store.recordFailure(ipBucket(ip), LIMITS.userIp.limit, LIMITS.userIp.windowMs),
    ]);
    return { kind: "invalid", status: 401, message: "invalid credentials" };
  }

  await deps.store.clear(phoneBucket(phone));
  return { kind: "ok", user };
}

/** Registration is counted per attempt (success clears), not per failure:
 *  a script creating accounts is trying to succeed. */
export async function checkRegisterAllowed(
  input: { phone: string; ip: string },
  store: AttemptStore,
): Promise<{ allowed: true } | { allowed: false; retryAfterSec: number }> {
  const phoneKey = `register:phone:${input.phone}`;
  const ipKey = `register:ip:${input.ip || "unknown"}`;
  const [byPhone, byIp] = await Promise.all([
    store.isBlocked(phoneKey, LIMITS.registerPhone.limit, LIMITS.registerPhone.windowMs),
    store.isBlocked(ipKey, LIMITS.registerIp.limit, LIMITS.registerIp.windowMs),
  ]);
  if (byPhone.blocked || byIp.blocked) {
    return { allowed: false, retryAfterSec: Math.max(byPhone.retryAfterSec, byIp.retryAfterSec, 1) };
  }
  return { allowed: true };
}

export async function recordRegisterAttempt(
  input: { phone: string; ip: string },
  store: AttemptStore,
): Promise<void> {
  await Promise.all([
    store.recordFailure(
      `register:phone:${input.phone}`,
      LIMITS.registerPhone.limit,
      LIMITS.registerPhone.windowMs,
    ),
    store.recordFailure(`register:ip:${input.ip || "unknown"}`, LIMITS.registerIp.limit, LIMITS.registerIp.windowMs),
  ]);
}

export async function clearRegisterAttempts(
  input: { phone: string; ip: string },
  store: AttemptStore,
): Promise<void> {
  await Promise.all([
    store.clear(`register:phone:${input.phone}`),
    store.clear(`register:ip:${input.ip || "unknown"}`),
  ]);
}
