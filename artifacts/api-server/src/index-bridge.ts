/**
 * EgyTrend — serverless bootstrap bridge.
 *
 * Vercel's function runs our Express app on every (cold) request, so the app
 * must be exported WITHOUT calling app.listen() — Vercel owns the port.
 *
 * 1. Load .env from the repo root (same behavior as src/index.ts locally;
 *    on Vercel this is a no-op because env vars arrive via the dashboard).
 * 2. Import the bundled Express app (bundle: ../dist/index.mjs, built by
 *    build.mjs) and strip the listen/backup-watchdog tail so nothing tries
 *    to bind a port in a serverless runtime.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

/* ── 1. env loading (root .env, non-overriding) ─────────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const candidates = [
  path.resolve(__dirname, "../../../.env"), // dist → api-server → artifacts → repo root
  path.resolve(__dirname, "../.env"), // artifacts/api-server/.env (optional)
];
for (const f of candidates) {
  try {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      const key = m[1];
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
        value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* never wedge boot over an env file */
  }
}

/* ── 2. import the real Express app ─────────────────────────────────────── */
/* The specifier is assembled at runtime so esbuild leaves it as a true lazy
 * import: at runtime (dist/index-bridge.mjs) it resolves to the sibling
 * dist/index.mjs produced by the SAME build — the full app, already bundled. */
const specifier = "./index" + ".mjs";
const { default: app } = (await import(specifier)) as {
  default: import("express").Express;
};

export default app;
