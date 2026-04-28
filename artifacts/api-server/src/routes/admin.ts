import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger";
import {
  listSources,
  upsertSource,
  deleteSource,
  listCustomArticles,
  upsertCustomArticle,
  deleteCustomArticle,
  type SourceMeta,
  type CustomArticle,
} from "../lib/dataStore";

const router: IRouter = Router();

/* Admin auth: bearer token equal to ADMIN_TOKEN env var (falls back to
 * SESSION_SECRET). The frontend stores this on login and sends it in
 * the X-Admin-Token header. */
const ADMIN_TOKEN =
  process.env["ADMIN_TOKEN"] || process.env["SESSION_SECRET"] || "";

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!ADMIN_TOKEN) {
    res
      .status(503)
      .json({ status: "error", message: "ADMIN_TOKEN not configured" });
    return;
  }
  const token =
    (req.header("x-admin-token") || "").trim() ||
    (req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== ADMIN_TOKEN) {
    res.status(401).json({ status: "error", message: "unauthorized" });
    return;
  }
  next();
}

/* Validation helpers */
const ALLOWED_LANG = new Set(["ar", "en"]);
const ALLOWED_CAT = new Set(["egypt", "global", "stocks", "crypto"]);
const ID_RX = /^[a-z0-9_-]{2,40}$/i;

function validateSource(input: unknown): SourceMeta | { error: string } {
  if (!input || typeof input !== "object") return { error: "body required" };
  const s = input as Record<string, unknown>;
  const id = String(s["id"] || "").trim();
  const name = String(s["name"] || "").trim();
  const icon = String(s["icon"] || "📰").trim().slice(0, 6);
  const lang = String(s["lang"] || "").trim();
  const cat = String(s["cat"] || "").trim();
  const color = String(s["color"] || "#10b981").trim();
  const url = String(s["url"] || "").trim();

  if (!ID_RX.test(id)) return { error: "id must match /^[a-z0-9_-]{2,40}$/i" };
  if (!name) return { error: "name required" };
  if (!ALLOWED_LANG.has(lang)) return { error: "lang must be ar|en" };
  if (!ALLOWED_CAT.has(cat))
    return { error: "cat must be egypt|global|stocks|crypto" };
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol)) {
      return { error: "url must be http(s)" };
    }
  } catch {
    return { error: "url invalid" };
  }
  if (!/^#[0-9a-f]{6}$/i.test(color)) return { error: "color must be #rrggbb" };

  return {
    id,
    name: name.slice(0, 60),
    icon,
    lang: lang as "ar" | "en",
    cat: cat as "egypt" | "global" | "stocks" | "crypto",
    color: color.toLowerCase(),
    url,
  };
}

function validateArticle(input: unknown): CustomArticle | { error: string } {
  if (!input || typeof input !== "object") return { error: "body required" };
  const a = input as Record<string, unknown>;
  const id =
    typeof a["id"] === "string" && a["id"].trim()
      ? String(a["id"]).trim()
      : `adm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const title = String(a["title"] || "").trim();
  const description = String(a["description"] || "").trim();
  const content =
    typeof a["content"] === "string" ? String(a["content"]) : undefined;
  const link = String(a["link"] || "#").trim() || "#";
  const cat = String(a["cat"] || "egypt").trim();
  const thumbnail =
    typeof a["thumbnail"] === "string" && a["thumbnail"].trim()
      ? String(a["thumbnail"]).trim()
      : undefined;
  const pubDate =
    typeof a["pubDate"] === "string" && a["pubDate"].trim()
      ? String(a["pubDate"]).trim()
      : new Date().toISOString();

  if (title.length < 4) return { error: "title required (min 4 chars)" };
  if (!ALLOWED_CAT.has(cat))
    return { error: "cat must be egypt|global|stocks|crypto" };
  // Validate optional URLs
  if (link !== "#") {
    try {
      const u = new URL(link);
      if (!["http:", "https:"].includes(u.protocol))
        return { error: "link must be http(s)" };
    } catch {
      return { error: "link invalid" };
    }
  }
  if (thumbnail) {
    try {
      const u = new URL(thumbnail);
      if (!["http:", "https:"].includes(u.protocol))
        return { error: "thumbnail must be http(s)" };
    } catch {
      return { error: "thumbnail invalid" };
    }
  }

  const article: CustomArticle = {
    id,
    title: title.slice(0, 300),
    description: description.slice(0, 1500),
    link,
    pubDate,
    cat: cat as CustomArticle["cat"],
    srcId: "admin",
    srcName: "تحرير المنصة",
    srcIcon: "✍️",
    srcColor: "#a855f7",
    srcLang: "ar",
    ...(content ? { content: content.slice(0, 8000) } : {}),
    ...(thumbnail ? { thumbnail } : {}),
  };
  return article;
}

/* ─── Public bootstrap (no auth) ─── */

router.get("/bootstrap", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    sources: listSources().map((s) => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      lang: s.lang,
      cat: s.cat,
      color: s.color,
    })),
    customArticles: listCustomArticles(),
  });
});

/* ─── Auth check ─── */

router.post("/login", (req: Request, res: Response) => {
  const expected =
    process.env["ADMIN_PASSWORD"] || "egytrend2026"; // legacy default kept
  const password = String((req.body || {}).password || "");
  if (password !== expected) {
    res.status(401).json({ status: "error", message: "invalid password" });
    return;
  }
  if (!ADMIN_TOKEN) {
    res
      .status(503)
      .json({ status: "error", message: "ADMIN_TOKEN not configured on server" });
    return;
  }
  res.json({ status: "ok", token: ADMIN_TOKEN });
});

/* ─── Source management (auth required) ─── */

router.get("/sources", requireAdmin, (_req: Request, res: Response) => {
  res.json({ status: "ok", sources: listSources() });
});

router.post("/sources", requireAdmin, async (req: Request, res: Response) => {
  const v = validateSource(req.body);
  if ("error" in v) {
    res.status(400).json({ status: "error", message: v.error });
    return;
  }
  await upsertSource(v);
  logger.info({ id: v.id }, "admin: source upserted");
  res.json({ status: "ok", source: v });
});

router.delete("/sources/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] || "");
  const ok = await deleteSource(id);
  if (!ok) {
    res.status(404).json({ status: "error", message: "not found" });
    return;
  }
  logger.info({ id }, "admin: source deleted");
  res.json({ status: "ok" });
});

/* ─── Custom article management (auth required) ─── */

router.get("/articles", requireAdmin, (_req: Request, res: Response) => {
  res.json({ status: "ok", articles: listCustomArticles() });
});

router.post("/articles", requireAdmin, async (req: Request, res: Response) => {
  const v = validateArticle(req.body);
  if ("error" in v) {
    res.status(400).json({ status: "error", message: v.error });
    return;
  }
  await upsertCustomArticle(v);
  logger.info({ id: v.id }, "admin: article upserted");
  res.json({ status: "ok", article: v });
});

router.delete(
  "/articles/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = String(req.params["id"] || "");
    const ok = await deleteCustomArticle(id);
    if (!ok) {
      res.status(404).json({ status: "error", message: "not found" });
      return;
    }
    logger.info({ id }, "admin: article deleted");
    res.json({ status: "ok" });
  },
);

export default router;
