/**
 * Authorization rules for the admin panel and the staff password upgrade path.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import {
  canDecidePayments,
  permissionForAdminPath,
  canManageEmployee,
  canManageStaff,
  canModifyUserAccounts,
  canReadStats,
  canReadUserAccounts,
  canSetEmployeeRole,
  createPermissionChecker,
  isEmployeeStatus,
  isStaffRole,
  normalizePermissions,
  STAFF_ROLES,
} from "./admin-permissions";
import {
  hashStaffPassword,
  staffPasswordNeedsUpgrade,
  verifyStaffPassword,
} from "./staff-password";

/* ── Roles ───────────────────────────────────────────────────────────────── */

test("only super_admin and admin manage staff accounts", () => {
  assert.equal(canManageStaff("super_admin"), true);
  assert.equal(canManageStaff("admin"), true);
  for (const role of ["editor", "analyst", "support", "marketing", "user", undefined]) {
    assert.equal(canManageStaff(role), false, String(role));
  }
});

test("only a super_admin may create or promote a super_admin", () => {
  assert.equal(canSetEmployeeRole("super_admin", "super_admin"), true);
  assert.equal(canSetEmployeeRole("admin", "super_admin"), false);
  /* An admin keeps the powers they already have, no more. */
  assert.equal(canSetEmployeeRole("admin", "editor"), true);
  assert.equal(canSetEmployeeRole("editor", "editor"), false);
  assert.equal(canSetEmployeeRole("super_admin", "root"), false);
});

test("an admin can never edit a super_admin (password reset would be a takeover)", () => {
  const superAdmin = { id: 1, role: "super_admin" };
  const otherAdmin = { id: 2, role: "admin" };
  assert.equal(canManageEmployee({ sub: 2, role: "admin" }, superAdmin), false);
  assert.equal(canManageEmployee({ sub: 1, role: "super_admin" }, otherAdmin), true);
  assert.equal(canManageEmployee({ sub: 3, role: "support" }, otherAdmin), false);
});

test("VIP changes, bans and payment decisions are money/account actions", () => {
  for (const role of ["super_admin", "admin"]) {
    assert.equal(canModifyUserAccounts(role), true, role);
    assert.equal(canDecidePayments(role), true, role);
  }
  for (const role of ["support", "editor", "analyst", "marketing", "user"]) {
    assert.equal(canModifyUserAccounts(role), false, role);
    assert.equal(canDecidePayments(role), false, role);
  }
});

test("support can read users and stats but nothing more", () => {
  assert.equal(canReadUserAccounts("support"), true);
  assert.equal(canReadStats("support"), true);
  assert.equal(canManageStaff("support"), false);
  assert.equal(canReadUserAccounts("marketing"), false);
});

test("every declared staff role is recognised and unknown roles are not", () => {
  for (const role of STAFF_ROLES) assert.equal(isStaffRole(role), true, role);
  assert.equal(isStaffRole("root"), false);
  assert.equal(isStaffRole(null), false);
});

test("employee status only accepts the two known values", () => {
  assert.equal(isEmployeeStatus("active"), true);
  assert.equal(isEmployeeStatus("disabled"), true);
  assert.equal(isEmployeeStatus("deleted"), false);
  assert.equal(isEmployeeStatus(1), false);
});

/* ── Staff password hashing / legacy upgrade ─────────────────────────────── */

test("a new staff password is salted scrypt and verifies", () => {
  const stored = hashStaffPassword("Str0ng-pass");
  assert.ok(stored.startsWith("scrypt$"));
  assert.equal(verifyStaffPassword("Str0ng-pass", stored), true);
  assert.equal(verifyStaffPassword("Str0ng-pas", stored), false);
});

test("the same password hashes differently every time (per-password salt)", () => {
  assert.notEqual(hashStaffPassword("same-password"), hashStaffPassword("same-password"));
});

test("a legacy sha256 hash still verifies and is flagged for upgrade", () => {
  const secret = "legacy-secret-for-test";
  const legacy = crypto.createHash("sha256").update("Old-pass" + secret).digest("hex");
  assert.equal(staffPasswordNeedsUpgrade(legacy), true);
  assert.equal(verifyStaffPassword("Old-pass", legacy, secret), true);
  assert.equal(verifyStaffPassword("wrong", legacy, secret), false);
});

test("after the upgrade the hash is scrypt and no longer needs migration", () => {
  const upgraded = hashStaffPassword("Old-pass");
  assert.equal(staffPasswordNeedsUpgrade(upgraded), false);
  assert.equal(verifyStaffPassword("Old-pass", upgraded, "unused-secret"), true);
});

test("rotating the session secret does not lock legacy hashes out", () => {
  const oldSecret = "the-previous-session-secret";
  const legacy = crypto.createHash("sha256").update("Old-pass" + oldSecret).digest("hex");
  const savedCurrent = process.env["SESSION_SECRET"];
  const savedPrevious = process.env["SESSION_SECRET_PREVIOUS"];
  process.env["SESSION_SECRET"] = "a-brand-new-session-secret";
  process.env["SESSION_SECRET_PREVIOUS"] = oldSecret;
  try {
    assert.equal(verifyStaffPassword("Old-pass", legacy), true, "the employee can still sign in once");
    assert.equal(verifyStaffPassword("wrong", legacy), false);
  } finally {
    if (savedCurrent === undefined) delete process.env["SESSION_SECRET"];
    else process.env["SESSION_SECRET"] = savedCurrent;
    if (savedPrevious === undefined) delete process.env["SESSION_SECRET_PREVIOUS"];
    else process.env["SESSION_SECRET_PREVIOUS"] = savedPrevious;
  }
});

test("a legacy hash cannot be verified without the session secret", () => {
  const legacy = crypto.createHash("sha256").update("Old-pass" + "missing-secret").digest("hex");
  const saved = process.env["SESSION_SECRET"];
  delete process.env["SESSION_SECRET"];
  try {
    assert.equal(verifyStaffPassword("Old-pass", legacy), false);
  } finally {
    if (saved !== undefined) process.env["SESSION_SECRET"] = saved;
  }
});

test("an empty password or hash never verifies", () => {
  assert.equal(verifyStaffPassword("", hashStaffPassword("x")), false);
  assert.equal(verifyStaffPassword("x", ""), false);
  assert.equal(verifyStaffPassword("x", "scrypt$broken"), false);
});

/* ── Stored fine-grained permissions ─────────────────────────────────────── */

test("admin route paths map to the permission they need", () => {
  assert.equal(permissionForAdminPath("/users"), "users");
  assert.equal(permissionForAdminPath("/users/action"), "users");
  assert.equal(permissionForAdminPath("/requests/req-1"), "payments");
  assert.equal(permissionForAdminPath("/sources"), "content");
  assert.equal(permissionForAdminPath("/articles/abc"), "content");
  assert.equal(permissionForAdminPath("/plans/7"), "plans");
  assert.equal(permissionForAdminPath("/coupons/c1"), "coupons");
  assert.equal(permissionForAdminPath("/employees/3"), "employees");
  assert.equal(permissionForAdminPath("/ai-config"), "ai");
  assert.equal(permissionForAdminPath("/ai-usage"), "ai");
  assert.equal(permissionForAdminPath("/audit-logs"), "audit");
  assert.equal(permissionForAdminPath("/settings/payment"), "settings");
  /* Unmapped paths keep the old role-only behaviour. */
  assert.equal(permissionForAdminPath("/stats"), null);
  assert.equal(permissionForAdminPath("/bootstrap"), null);
});

test("permission lists are cleaned before they are stored", () => {
  assert.deepEqual(normalizePermissions(["Users", " users ", "AI", "root", 42, ""]), ["users", "ai"]);
  assert.deepEqual(normalizePermissions("users"), []);
  assert.deepEqual(normalizePermissions(undefined), []);
});

function checkerWith(list: string[] | null) {
  let lookups = 0;
  const checker = createPermissionChecker(async () => {
    lookups += 1;
    return list;
  });
  return { checker, lookups: () => lookups };
}

test("super_admin passes every gate regardless of a stored list", async () => {
  const { checker, lookups } = checkerWith([]);
  assert.equal(await checker.check({ sub: 1, role: "super_admin" }, "payments"), "granted");
  assert.equal(lookups(), 0, "super_admin must not need a database read");
});

test("a role-only account keeps the old behaviour (empty list grants)", async () => {
  const { checker } = checkerWith([]);
  assert.equal(await checker.check({ sub: 2, role: "editor" }, "content"), "granted");
});

test("an explicit list denies the actions it omits", async () => {
  const { checker } = checkerWith(["content"]);
  const actor = { sub: 3, role: "editor" };
  assert.equal(await checker.check(actor, "content"), "granted");
  assert.equal(await checker.check(actor, "payments"), "denied");
  assert.equal(await checker.check(actor, "employees"), "denied");
});

test("an anonymous or role-less actor is always denied", async () => {
  const { checker } = checkerWith(null);
  assert.equal(await checker.check(null, "content"), "denied");
  assert.equal(await checker.check({ sub: 1 }, "content"), "denied");
  assert.equal(await checker.effective(null), null);
});

test("a lookup failure is an error, never a silent grant", async () => {
  const checker = createPermissionChecker(async () => {
    throw new Error("database down");
  });
  assert.equal(await checker.check({ sub: 4, role: "admin" }, "users"), "error");
});

test("a permission change applies on the next request (no cache by default)", async () => {
  let list = ["users"];
  const checker = createPermissionChecker(async () => list);
  const actor = { sub: 5, role: "support" };
  assert.equal(await checker.check(actor, "users"), "granted");
  list = ["payments"];
  assert.equal(await checker.check(actor, "users"), "denied", "revocation must not wait for a TTL");
  assert.equal(await checker.check(actor, "payments"), "granted");
});

test("an explicit TTL caches the list and invalidate() drops it", async () => {
  let list = ["users"];
  let lookups = 0;
  const checker = createPermissionChecker(
    async () => {
      lookups += 1;
      return list;
    },
    { ttlMs: 60_000 },
  );
  const actor = { sub: 6, role: "support" };
  assert.equal(await checker.check(actor, "users"), "granted");
  assert.equal(await checker.check(actor, "users"), "granted");
  assert.equal(lookups, 1);
  list = ["payments"];
  assert.equal(await checker.check(actor, "users"), "granted", "still inside the TTL");
  checker.invalidate(6);
  assert.equal(await checker.check(actor, "users"), "denied");
});
