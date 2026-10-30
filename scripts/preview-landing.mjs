#!/usr/bin/env node
/**
 * DEV-ONLY preview server for the guest landing.
 *
 * Why it exists: this sandbox has no route to the licensed data providers
 * (or to the production deployment) — only a fixed allow-list of hosts.
 * The production API server itself needs PostgreSQL, which the sandbox also
 * lacks. So /api/* here is answered from a SNAPSHOT of the real production
 * API captured on 2026-10-30 (real values, real sources, real asOf
 * timestamps — see preview-data/README.md). Nothing in this file synthesises
 * a price; a row the snapshot does not carry stays exactly what the server
 * would say about it ("غير متاح").
 *
 * Static files come from the BUILT site (artifacts/egytrend/dist) — run
 * `pnpm run build` in artifacts/egytrend first.
 *
 *   node scripts/preview-landing.mjs     →  http://0.0.0.0:5173
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(here, "..", "artifacts", "egytrend", "dist", "public");
const DATA = resolve(here, "preview-data");
const PORT = Number(process.env.PORT || 5173);

const API_FILES = {
  "/api/markets": "markets.json",
  "/api/markets/sparklines": "sparklines.json",
  "/api/markets/stocks": "stocks.json",
  "/api/markets/us-stocks": "us-stocks.json",
  "/api/markets/calendar": "calendar.json",
  "/api/news": "news.json",
  "/api/news/sources": "news-sources.json",
  "/api/payments/config": "payments-config.json",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, "http://localhost");
  } catch {
    sendJson(res, 400, { status: "error" });
    return;
  }
  const path = u.pathname;
  try {
    /* ── API: the production snapshot (real data, no synthesis) ── */
    if (path.startsWith("/api/")) {
      if (path === "/api/health") {
        sendJson(res, 200, { status: "ok", ts: Date.now(), mode: "preview-snapshot" });
        return;
      }
      const file = API_FILES[path];
      if (!file) {
        sendJson(res, 404, { status: "error", message: "not_in_preview_snapshot" });
        return;
      }
      const raw = await readFile(join(DATA, file), "utf8");
      let doc = JSON.parse(raw);
      if (path === "/api/markets/sparklines") {
        /* Honour ?ids= like the real endpoint: return only requested
         * instruments; an id absent from the snapshot is available:false
         * (the fail-closed shape), never invented points. */
        const ids = [...new Set(
          (u.searchParams.get("ids") || "").split(",").map(s => s.trim()).filter(Boolean),
        )];
        const known = new Set((doc.series || []).map(s => String(s.instrumentId)));
        doc.series = ids.length
          ? ids.map(id => {
              const hit = (doc.series || []).find(s => String(s.instrumentId) === id);
              return hit ?? { instrumentId: id, available: false, points: [] };
            })
          : doc.series;
        void known;
      }
      sendJson(res, 200, doc);
      return;
    }

    /* ── Static: the built site ── */
    const rel = path === "/" ? "/index.html" : path;
    const full = resolve(DIST, "." + rel);
    if (!full.startsWith(DIST + "/") && full !== DIST) {
      sendJson(res, 403, { status: "error" });
      return;
    }
    try {
      const st = await stat(full);
      const target = st.isDirectory() ? join(full, "index.html") : full;
      const body = await readFile(target);
      res.writeHead(200, {
        "Content-Type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(body);
    } catch {
      /* SPA fallback */
      const body = await readFile(join(DIST, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(body);
    }
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("preview server error: " + (e && e.message ? e.message : String(e)));
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[preview-landing] static:  ${DIST}`);
  console.log(`[preview-landing] api:     ${DATA} (production snapshot 2026-10-30)`);
  console.log(`[preview-landing] ready:   http://0.0.0.0:${PORT}`);
});
