/**
 * Staff password hashing.
 *
 * New hashes: scrypt with a random per-password salt (`scrypt$salt$hash`).
 * Legacy hashes: `sha256(password + SESSION_SECRET)` — unsalted, so identical
 * passwords share a hash and a leaked secret makes them cheap to attack. They
 * are never produced any more; an account that still has one is upgraded to
 * scrypt the moment its owner logs in successfully (see `staffPasswordNeedsUpgrade`).
 */
import crypto from "crypto";

const SCRYPT_KEYLEN = 64;

export function hashStaffPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

/** True when this stored hash is the weak legacy format. */
export function staffPasswordNeedsUpgrade(encoded: string): boolean {
  return !encoded.startsWith("scrypt$");
}

function legacyHash(password: string, secret: string): string {
  return crypto.createHash("sha256").update(password + secret).digest("hex");
}

/** Constant-time verification for both formats. A legacy hash cannot be
 *  verified without the session secret, and a missing secret is a refusal, not
 *  a fallback to a weaker comparison.
 *
 *  Legacy hashes are peppered with SESSION_SECRET, so rotating that secret
 *  would lock every employee who has not logged in since the last rotation out
 *  of their account (and their password is not recoverable). Setting the old
 *  value in SESSION_SECRET_PREVIOUS lets them sign in once more; the login
 *  upgrades the hash to salted scrypt, so the old secret can then be removed. */
export function verifyStaffPassword(password: string, encoded: string, secret?: string): boolean {
  if (!password || !encoded) return false;
  if (encoded.startsWith("scrypt$")) {
    const [, salt, expected] = encoded.split("$");
    if (!salt || !expected) return false;
    try {
      const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
      const expectedBuf = Buffer.from(expected, "hex");
      return expectedBuf.length === actual.length && crypto.timingSafeEqual(actual, expectedBuf);
    } catch {
      return false;
    }
  }
  const stored = Buffer.from(encoded);
  const secrets = [secret ?? process.env["SESSION_SECRET"], process.env["SESSION_SECRET_PREVIOUS"]]
    .filter((s): s is string => Boolean(s));
  if (secrets.length === 0) return false;
  let matched = false;
  for (const key of secrets) {
    const candidate = Buffer.from(legacyHash(password, key));
    /* Compare every candidate: timing must not reveal which secret matched. */
    if (stored.length === candidate.length && crypto.timingSafeEqual(candidate, stored)) {
      matched = true;
    }
  }
  return matched;
}
