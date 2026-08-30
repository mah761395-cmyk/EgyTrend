import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { appUsersTable } from "@workspace/db/schema";
import { db } from "@workspace/db";
import {
  checkUserPassword,
  currentUser,
  hashUserPassword,
  normalizeUserPhone,
  signUserToken,
} from "../lib/userAuth";

const router = Router();

function publicUser(user: typeof appUsersTable.$inferSelect) {
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    plan: user.plan === "vip" && user.vipExpiresAt && user.vipExpiresAt.getTime() <= Date.now() ? "free" : user.plan,
    vipExpiresAt: user.vipExpiresAt?.toISOString() || null,
  };
}

router.post("/register", async (req: Request, res: Response) => {
  const phone = normalizeUserPhone(req.body?.phone);
  const name = String(req.body?.name || "").trim().slice(0, 80);
  const password = String(req.body?.password || "");
  if (!/^01\d{9}$/.test(phone) || !name || password.length < 8) {
    res.status(400).json({ status: "error", message: "valid phone, name and password of at least 8 characters required" });
    return;
  }

  const existing = await db.select({ id: appUsersTable.id }).from(appUsersTable)
    .where(eq(appUsersTable.phone, phone)).limit(1);
  if (existing.length) {
    res.status(409).json({ status: "error", message: "phone already registered" });
    return;
  }

  const [user] = await db.insert(appUsersTable).values({
    phone,
    name,
    passwordHash: hashUserPassword(password),
  }).returning();
  const token = signUserToken({ sub: user.id, phone: user.phone, name: user.name, role: "user", plan: user.plan });
  res.status(201).json({ status: "ok", token, user: publicUser(user) });
});

router.post("/login", async (req: Request, res: Response) => {
  const phone = normalizeUserPhone(req.body?.phone);
  const password = String(req.body?.password || "");
  if (!phone || !password) {
    res.status(400).json({ status: "error", message: "phone and password required" });
    return;
  }
  const [user] = await db.select().from(appUsersTable)
    .where(and(eq(appUsersTable.phone, phone), eq(appUsersTable.status, "active"))).limit(1);
  if (!user || !checkUserPassword(password, user.passwordHash)) {
    res.status(401).json({ status: "error", message: "invalid credentials" });
    return;
  }
  const normalized = publicUser(user);
  const token = signUserToken({
    sub: user.id,
    phone: user.phone,
    name: user.name,
    role: "user",
    plan: normalized.plan,
    ...(normalized.vipExpiresAt ? { vipExpiresAt: normalized.vipExpiresAt } : {}),
  });
  await db.update(appUsersTable).set({ updatedAt: new Date() }).where(eq(appUsersTable.id, user.id));
  res.json({ status: "ok", token, user: normalized });
});

router.get("/me", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const [user] = await db.select().from(appUsersTable)
    .where(and(eq(appUsersTable.id, claims.sub), eq(appUsersTable.status, "active"))).limit(1);
  if (!user) {
    res.status(401).json({ status: "error", message: "user not found" });
    return;
  }
  res.json({ status: "ok", user: publicUser(user) });
});

router.put("/password", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (!claims || !currentPassword || newPassword.length < 8) {
    res.status(400).json({ status: "error", message: "login required and new password must be at least 8 characters" });
    return;
  }
  const [user] = await db.select().from(appUsersTable)
    .where(and(eq(appUsersTable.id, claims.sub), eq(appUsersTable.status, "active"))).limit(1);
  if (!user || !checkUserPassword(currentPassword, user.passwordHash)) {
    res.status(401).json({ status: "error", message: "current password is incorrect" });
    return;
  }
  await db.update(appUsersTable).set({
    passwordHash: hashUserPassword(newPassword),
    updatedAt: new Date(),
  }).where(eq(appUsersTable.id, user.id));
  res.json({ status: "ok" });
});

export default router;