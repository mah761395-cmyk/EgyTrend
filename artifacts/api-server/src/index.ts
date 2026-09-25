import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import app from "./app";
import { logger } from "./lib/logger";

/* Load repo-root .env (and api-server/.env) at boot — WITHOUT overriding
 * variables already present in the environment. This makes SMTP_*,
 * APP_BASE_URL, ANTHROPIC_API_KEY and friends drop-in: the user only
 * edits the .env file and restarts; no launcher changes needed. */
function loadEnvFiles(): void {
  let dir = __dirname; // dist/ when built, src/ when run directly
  let root = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "scripts", "backup-db.mjs"))) { root = dir; break; }
    dir = path.resolve(dir, "..");
  }
  const files = [path.join(root, ".env"), path.join(root, "artifacts", "api-server", ".env")];
  for (const f of files) {
    try {
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m || line.trim().startsWith("#")) continue;
        const key = m[1];
        let value = m[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      /* never wedge boot over an env file */
    }
  }
}
loadEnvFiles();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// ── Daily DB backup (in-process watchdog) ─────────────────────────────────
// Windows Task Scheduler proved unreliable in this environment, so the
// always-running API server owns the schedule instead: every 30 minutes it
// checks backups/ for today's egytrend-YYYYMMDD.sql.gz and, if missing,
// spawns scripts/backup-db.mjs (single run — the script handles the lock,
// 7-day retention and its own logging). On a VPS, a cron job producing the
// same file name naturally takes over and the watchdog stays idle.
function resolveProjectRoot(): string {
  let dir = __dirname; // dist/ when built, src/ when run directly
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "scripts", "backup-db.mjs"))) return dir;
    dir = path.resolve(dir, "..");
  }
  return process.cwd();
}
const PROJECT_ROOT = resolveProjectRoot();
const BACKUPS_DIR = path.join(PROJECT_ROOT, "backups");

function todaysBackupExists(): boolean {
  try {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return fs.existsSync(path.join(BACKUPS_DIR, `egytrend-${stamp}.sql.gz`));
  } catch {
    return true; // never wedge the server over a backup check
  }
}

function maybeRunDailyBackup(): void {
  if (todaysBackupExists()) return;
  const child = spawn(
    process.execPath,
    [path.join(PROJECT_ROOT, "scripts", "backup-db.mjs")],
    { stdio: "ignore" },
  );
  child.on("error", (e) => logger.warn({ err: e }, "DB backup spawn failed"));
  child.on("exit", (code) => {
    if (code === 0) logger.info("daily DB backup completed");
    else logger.warn({ code }, "daily DB backup failed");
  });
}

setTimeout(maybeRunDailyBackup, 20 * 1000).unref?.(); // shortly after boot
setInterval(maybeRunDailyBackup, 30 * 60 * 1000).unref?.();
