import { Router, type Request, type Response } from "express";
import { currentUser } from "../lib/userAuth";
import {
  activeBroadcastForViewer,
  activeBroadcastMediaForViewer,
  claimBroadcastForUser,
  recordBroadcastUserEvent,
} from "../lib/broadcasts";
import { logger } from "../lib/logger";

const router = Router();

function broadcastId(value: unknown): string | null {
  const id = String(value || "").trim();
  return /^broadcast-[a-zA-Z0-9_-]{8,100}$/.test(id) ? id : null;
}

function mediaId(value: unknown): string | null {
  const id = String(value || "").trim();
  return /^broadcast-media-[a-zA-Z0-9_-]{8,100}$/.test(id) ? id : null;
}

/** Browser-only guest state is a display suppression hint, never a source of
 * audience eligibility or authorization. */
function guestSeenIds(value: unknown): string[] {
  return String(value || "").split(",")
    .map((id) => id.trim())
    .filter((id) => /^broadcast-[a-zA-Z0-9_-]{8,100}$/.test(id))
    .slice(0, 50);
}

/* Lightweight candidate lookup. A logged-in visitor is checked against DB
 * state; a guest may suppress only IDs that its own browser previously saw.
 * The frontend claims a registered message before presenting it, so racing
 * tabs cannot both show it. */
router.get("/active", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  try {
    const message = await activeBroadcastForViewer({
      claims,
      excludeIds: claims ? [] : guestSeenIds(req.query["seen"]),
      now: new Date(),
    });
    res.setHeader("Vary", "Cookie, Authorization");
    res.setHeader("Cache-Control", claims ? "private, max-age=30" : "public, max-age=30");
    res.json({ status: "ok", message, generatedAt: new Date().toISOString(), cacheSeconds: 30 });
  } catch (error) {
    logger.error({ err: error }, "active broadcast lookup error");
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ status: "error", message: "الرسائل العامة غير متاحة حاليًا" });
  }
});

/* A registered user is only considered to have seen a message after this
 * idempotent, unique DB claim succeeds. Guests intentionally remain local. */
router.post("/active/:id/claim", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  const id = broadcastId(req.params["id"]);
  if (!claims) { res.status(401).json({ status: "error", message: "login required" }); return; }
  if (!id) { res.status(404).json({ status: "error", message: "الرسالة غير موجودة." }); return; }
  try {
    const claimed = await claimBroadcastForUser(id, claims, new Date());
    res.setHeader("Cache-Control", "no-store");
    if (claimed.status === "claimed") { res.json({ status: "ok", message: claimed.message }); return; }
    if (claimed.status === "already_seen") { res.status(409).json({ status: "already_seen" }); return; }
    res.status(404).json({ status: "not_available" });
  } catch (error) {
    logger.error({ err: error }, "broadcast claim error");
    res.status(503).json({ status: "error", message: "تعذر تسجيل ظهور الرسالة حاليًا" });
  }
});

router.post("/:id/events", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  const id = broadcastId(req.params["id"]);
  const event = String(req.body?.event || "");
  if (!claims) { res.status(401).json({ status: "error", message: "login required" }); return; }
  if (!id || !["close", "do_not_show_again", "cta_click", "coupon_copy"].includes(event)) {
    res.status(400).json({ status: "error", message: "حدث الرسالة غير صالح." });
    return;
  }
  try {
    const recorded = await recordBroadcastUserEvent({
      messageId: id,
      claims,
      event: event as "close" | "do_not_show_again" | "cta_click" | "coupon_copy",
      now: new Date(),
    });
    res.setHeader("Cache-Control", "no-store");
    if (!recorded) { res.status(404).json({ status: "error", message: "سجل ظهور الرسالة غير موجود." }); return; }
    res.status(204).end();
  } catch (error) {
    logger.error({ err: error }, "broadcast event error");
    res.status(503).json({ status: "error", message: "تعذر حفظ تفاعل الرسالة حاليًا" });
  }
});

/* Only active content for the present viewer can expose its image. */
router.get("/media/:id", async (req: Request, res: Response) => {
  const id = mediaId(req.params["id"]);
  if (!id) { res.status(404).end(); return; }
  try {
    const media = await activeBroadcastMediaForViewer(id, currentUser(req), new Date());
    if (!media) { res.status(404).end(); return; }
    const encoded = media.dataUrl.split(",", 2)[1];
    if (!encoded) { res.status(404).end(); return; }
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Vary", "Cookie, Authorization");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type(media.mimeType).send(Buffer.from(encoded, "base64"));
  } catch (error) {
    logger.error({ err: error }, "public broadcast media error");
    res.status(503).end();
  }
});

export default router;
