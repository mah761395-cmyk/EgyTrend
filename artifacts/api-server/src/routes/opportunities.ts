import { Router } from "express";
import { db } from "@workspace/db";
import { opportunities } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import crypto from "crypto";
import jwt from "jsonwebtoken";

const router = Router();

const JWT_SECRET = process.env["SESSION_SECRET"] || "egytrend-secret-2026";
const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"] || "egytrend2026";
const LEGACY_TOKEN = process.env["ADMIN_TOKEN"] || process.env["SESSION_SECRET"] || "";

function isAdmin(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!token) return false;
  if (LEGACY_TOKEN && token === LEGACY_TOKEN) return true;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { role?: string };
    return payload.role === "admin";
  } catch {
    return false;
  }
}

function requireAuth(req: any, res: any, next: any) {
  if (!isAdmin(req)) return res.status(401).json({ status: "error", message: "unauthorized" });
  next();
}

router.get("/opportunities", async (req, res) => {
  try {
    const admin = isAdmin(req);
    const all = await db.select().from(opportunities).orderBy(desc(opportunities.createdAt));
    const visible = admin ? all : all.filter(o => o.status !== "deleted");
    res.json({ status: "ok", opportunities: visible });
  } catch (e) {
    res.status(500).json({ status: "error", message: "Failed to fetch opportunities" });
  }
});

router.post("/opportunities", requireAuth, async (req, res) => {
  try {
    const { title, summary, details, type, market, expectedReturn, riskLevel, sector, duration, deadline, status, featured, vipOnly } = req.body;
    if (!title || !summary || !type || !market) {
      return res.status(400).json({ status: "error", message: "title, summary, type, market required" });
    }
    const id = crypto.randomUUID().slice(0, 12);
    await db.insert(opportunities).values({
      id,
      title,
      summary,
      details: details || null,
      type,
      market,
      expectedReturn: expectedReturn || null,
      riskLevel: riskLevel ?? 3,
      sector: sector || null,
      duration: duration || null,
      deadline: deadline || null,
      status: status || "active",
      featured: featured ?? false,
      vipOnly: vipOnly ?? false,
    });
    res.json({ status: "ok", id });
  } catch (e) {
    res.status(500).json({ status: "error", message: "Failed to create opportunity" });
  }
});

router.put("/opportunities/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, summary, details, type, market, expectedReturn, riskLevel, sector, duration, deadline, status, featured, vipOnly } = req.body;
    await db.update(opportunities)
      .set({
        ...(title !== undefined && { title }),
        ...(summary !== undefined && { summary }),
        ...(details !== undefined && { details }),
        ...(type !== undefined && { type }),
        ...(market !== undefined && { market }),
        ...(expectedReturn !== undefined && { expectedReturn }),
        ...(riskLevel !== undefined && { riskLevel }),
        ...(sector !== undefined && { sector }),
        ...(duration !== undefined && { duration }),
        ...(deadline !== undefined && { deadline }),
        ...(status !== undefined && { status }),
        ...(featured !== undefined && { featured }),
        ...(vipOnly !== undefined && { vipOnly }),
        updatedAt: new Date(),
      })
      .where(eq(opportunities.id, id));
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ status: "error", message: "Failed to update opportunity" });
  }
});

router.delete("/opportunities/:id", requireAuth, async (req, res) => {
  try {
    await db.delete(opportunities).where(eq(opportunities.id, req.params.id));
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ status: "error", message: "Failed to delete opportunity" });
  }
});

export default router;
