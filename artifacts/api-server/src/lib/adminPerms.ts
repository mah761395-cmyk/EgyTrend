import { db } from "@workspace/db";
import { employeesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

/** Unified set of actions the staff UI can perform. All other values are
 *  reserved and must never be accepted. */
export const ADMIN_PERMISSIONS = [
  "users",
  "payments",
  "content",
  "plans",
  "coupons",
  "employees",
  "ai",
  "audit",
  "settings",
  "opportunities",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/** Normalize untrusted input into a clean permission list. Unknown values are
 *  dropped (never accepted), duplicates removed, upper/lower case folded. */
export function normalizePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of input) {
    const key = String(p).trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/* ─── Permission checking ───────────────────────────────────────────────────

`actor` is the verified JWT payload (sub = employee id, role carried by the
staff session). The check runs against the live employee row on every request
so a revocation takes effect immediately; the JWT only ever carries the role.

  • super_admin → never restricted
  • empty list  → the role alone decides (backward compatible)
  • non-empty   → the action must be in the list

A lookup failure returns "error" so callers can answer 503 instead of silently
over-granting or over-denying. */

/* ─── Session probe (the admin panel's /me) ────────────────────────────────

`sub` is the employee row id. The DB returns the stored permission list, or
null when the row no longer exists (fail closed: a staff account without a row
loses even the role defaults). */
export async function effectivePermissions(
  actor: { sub?: number | string; role?: string } | null | undefined,
): Promise<string[] | null> {
  if (!actor?.role || actor.role === "super_admin") return null;
  try {
    const id = Number(actor.sub);
    const [emp] = await db
      .select({ permissions: employeesTable.permissions })
      .from(employeesTable)
      .where(eq(employeesTable.id, id))
      .limit(1);
    if (!emp || !Array.isArray(emp.permissions)) return null;
    return emp.permissions.map((p) => String(p).trim().toLowerCase());
  } catch {
    return null;
  }
}
export type PermDecision = "granted" | "denied" | "error";

export async function checkEmployeePermission(
  actor: { sub?: number | string; role?: string; email?: string } | null | undefined,
  permission: AdminPermission,
): Promise<PermDecision> {
  if (!actor || !actor.role) return "denied";
  if (actor.role === "super_admin") return "granted";
  try {
    const id = Number(actor.sub);
    const [emp] = await db
      .select({ permissions: employeesTable.permissions })
      .from(employeesTable)
      .where(eq(employeesTable.id, id))
      .limit(1);
    const list = Array.isArray(emp?.permissions)
      ? emp.permissions.map((p) => String(p).trim().toLowerCase())
      : [];
    if (list.length > 0 && !list.includes(permission)) return "denied";
    return "granted";
  } catch (e) {
    logger.error(
      { err: e, actor: actor.email, permission },
      "admin permission lookup failed",
    );
    return "error";
  }
}
