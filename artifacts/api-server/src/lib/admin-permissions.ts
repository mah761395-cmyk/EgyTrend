/**
 * Pure authorization rules for the admin panel.
 *
 * Kept out of `routes/admin.ts` so each rule can be tested directly, and so a
 * route can never drift into "requireAuth is enough" by accident: any endpoint
 * that changes money, accounts or staff must ask one of these functions.
 *
 * Principle: nobody may perform an action that grants more authority than they
 * already hold, and an `admin` may never modify a `super_admin` (resetting a
 * super_admin's password or e-mail would be a full takeover).
 */

export const STAFF_ROLES = [
  "super_admin",
  "admin",
  "editor",
  "analyst",
  "support",
  "marketing",
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(STAFF_ROLES);

export function isStaffRole(role: unknown): role is StaffRole {
  return typeof role === "string" && ROLE_SET.has(role);
}

/** Roles that can mint, revoke or reassign other staff accounts. */
export function canManageStaff(role: unknown): boolean {
  return role === "super_admin" || role === "admin";
}

/** Only a super_admin may create or promote to super_admin. */
export function canSetEmployeeRole(actorRole: unknown, nextRole: unknown): boolean {
  if (!isStaffRole(nextRole)) return false;
  if (nextRole === "super_admin") return actorRole === "super_admin";
  return canManageStaff(actorRole);
}

/** Can `actor` edit/disable this employee at all? */
export function canManageEmployee(
  actor: { sub?: number; role?: string },
  target: { id: number; role: string },
): boolean {
  if (!canManageStaff(actor.role)) return false;
  /* An admin editing a super_admin (password, e-mail, status) is escalation. */
  if (target.role === "super_admin" && actor.role !== "super_admin") return false;
  return true;
}

/** Granting or revoking VIP, banning and unbanning are money/account actions. */
export function canModifyUserAccounts(role: unknown): boolean {
  return role === "super_admin" || role === "admin";
}

export function canReadUserAccounts(role: unknown): boolean {
  return role === "super_admin" || role === "admin" || role === "support";
}

/** Approving a payment grants VIP, so support can review but never decide. */
export function canDecidePayments(role: unknown): boolean {
  return role === "super_admin" || role === "admin";
}

export function canReadStats(role: unknown): boolean {
  return role === "super_admin" || role === "admin" || role === "support";
}

/** Employee status values the panel may set. */
export const EMPLOYEE_STATUSES = ["active", "disabled"] as const;

export function isEmployeeStatus(value: unknown): boolean {
  return typeof value === "string" && (EMPLOYEE_STATUSES as readonly string[]).includes(value);
}

/* ── Stored fine-grained permissions ──────────────────────────────────────
 * Ported from the reviewed work in 1687bd9 and adapted to this branch.
 *
 * The `employees.permissions` jsonb column already exists in the schema and in
 * the production database, so **no migration is required** — this only starts
 * honouring a column that was previously written but never enforced.
 *
 * Semantics (unchanged from 1687bd9 so existing rows keep working):
 *   • super_admin            → always granted
 *   • empty permission list  → the role alone decides (backward compatible)
 *   • non-empty list         → the action must be listed
 *
 * Enforcement is server-side on every gated route. The list is read from the
 * employee row on every check (no cache by default), so revoking a permission
 * takes effect on the next request even when another instance made the change;
 * a lookup failure answers 503 (fail closed) rather than silently granting or
 * denying. A positive TTL can be passed when a deployment prefers one query per
 * TTL over one per request.
 */

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
  /* Pricing stays a separate, narrower gate (requirePricingAccess) but is a
   * real staff permission already used by the panel. */
  "pricing.manage",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(ADMIN_PERMISSIONS);

export function isAdminPermission(value: unknown): value is AdminPermission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

/** Admin route path (relative to /api/admin) → the permission it needs.
 *
 * The routes already carry a role allowlist; this adds the per-employee list on
 * top without repeating the mapping in 50 handlers. An unmapped path is decided
 * by the role alone, exactly as before this change. */
export const ADMIN_PERMISSION_ROUTES: ReadonlyArray<{ pattern: RegExp; permission: AdminPermission }> = [
  { pattern: /^\/(users|user-notifications)(\/|$)/, permission: "users" },
  { pattern: /^\/(requests|subscriptions|payments)(\/|$)/, permission: "payments" },
  { pattern: /^\/(sources|articles|broadcasts)(\/|$)/, permission: "content" },
  { pattern: /^\/plans(\/|$)/, permission: "plans" },
  { pattern: /^\/coupons(\/|$)/, permission: "coupons" },
  { pattern: /^\/employees(\/|$)/, permission: "employees" },
  { pattern: /^\/ai-/, permission: "ai" },
  { pattern: /^\/audit-logs(\/|$)/, permission: "audit" },
  { pattern: /^\/settings(\/|$)/, permission: "settings" },
];

export function permissionForAdminPath(path: string): AdminPermission | null {
  const clean = path.split("?")[0] ?? "";
  for (const route of ADMIN_PERMISSION_ROUTES) {
    if (route.pattern.test(clean)) return route.permission;
  }
  return null;
}

/** Untrusted input → clean list. Unknown values are dropped, duplicates and
 *  whitespace removed, case folded. */
export function normalizePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const key = String(raw).trim().toLowerCase();
    if (!key || seen.has(key) || !PERMISSION_SET.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export type PermDecision = "granted" | "denied" | "error";

export type PermissionLookup = (employeeId: number) => Promise<string[] | null>;

export type Actor = { sub?: number | string; role?: string; email?: string };

export type PermissionChecker = {
  check(actor: Actor | null | undefined, permission: AdminPermission): Promise<PermDecision>;
  /** Effective list for the panel's /me (null when the role decides). */
  effective(actor: Actor | null | undefined): Promise<string[] | null>;
  invalidate(employeeId?: number): void;
};

export function createPermissionChecker(
  lookup: PermissionLookup,
  options: { ttlMs?: number; now?: () => number } = {},
): PermissionChecker {
  /* 0 = live: revocation is seen by every instance immediately. */
  const ttlMs = options.ttlMs ?? 0;
  const now = options.now ?? Date.now;
  const cache = new Map<number, { list: string[] | null; at: number }>();

  async function stored(employeeId: number): Promise<string[] | null> {
    const hit = ttlMs > 0 ? cache.get(employeeId) : undefined;
    if (hit && now() - hit.at < ttlMs) return hit.list;
    const list = await lookup(employeeId);
    if (cache.size > 2_000) cache.clear();
    cache.set(employeeId, { list, at: now() });
    return list;
  }

  return {
    async check(actor, permission) {
      if (!actor || !actor.role) return "denied";
      if (actor.role === "super_admin") return "granted";
      const id = Number(actor.sub);
      if (!Number.isFinite(id)) return "denied";
      try {
        const list = await stored(id);
        /* No row, or a row with no explicit list: the role already decided. */
        if (!list || list.length === 0) return "granted";
        return list.includes(permission) ? "granted" : "denied";
      } catch {
        return "error";
      }
    },

    async effective(actor) {
      if (!actor || !actor.role || actor.role === "super_admin") return null;
      const id = Number(actor.sub);
      if (!Number.isFinite(id)) return null;
      try {
        return await stored(id);
      } catch {
        return null;
      }
    },

    invalidate(employeeId) {
      if (employeeId === undefined) cache.clear();
      else cache.delete(employeeId);
    },
  };
}
