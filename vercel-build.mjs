/**
 * EgyTrend — Vercel build script (runs on Vercel's Linux build machine).
 *
 * Vercel build images have Node but NOT pnpm preinstalled. corepack ships
 * with every Node ≥ 16, so we activate pnpm through it, then build the whole
 * monorepo exactly like locally (`pnpm run build`).
 *
 * Steps (invoked by vercel.json buildCommand = "node vercel-build.mjs"):
 *   1. enable corepack pnpm (pinned version, matches the local lockfile)
 *   2. pnpm install --frozen-lockfile (root install covers all workspaces)
 *   3. pnpm run build → typecheck + libs + api-server esbuild bundle + SPA
 *   4. sanity-check the two outputs Vercel will serve:
 *        artifacts/egytrend/dist/public/index.html      (static SPA)
 *        artifacts/api-server/dist/index-bridge.mjs     (serverless API entry)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

const run = (cmd, args, cwd = root) => {
  console.log(`\n▶ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: false, env: process.env });
  if (r.status !== 0) fail(`command failed: ${cmd} ${args.join(" ")}`);
};

console.log("◆ EgyTrend — Vercel build");

/* 1. make sure pnpm exists (corepack is bundled with Node on Vercel images) */
let hasPnpm = spawnSync("pnpm", ["--version"], { stdio: "ignore", shell: false }).status === 0;
if (!hasPnpm) {
  console.log("◆ pnpm not found — activating via corepack…");
  run("corepack", ["enable"]);
  run("corepack", ["prepare", "pnpm@12.3.4", "--activate"]);
  hasPnpm = spawnSync("pnpm", ["--version"], { stdio: "ignore", shell: false }).status === 0;
  if (!hasPnpm) fail("could not activate pnpm via corepack");
}

/* 2. install every workspace from the lockfile (root install = all packages) */
run("pnpm", ["install", "--frozen-lockfile"]);

/* 3. build all workspaces: typecheck + libs + API bundle + SPA
 *    (workspaces whose build needs only node resolve normally; pnpm itself is
 *    already alive via corepack — the fallbacks in package.json cover the rest) */
run("pnpm", ["run", "build"]);

/* 4. the two artifacts Vercel actually serves must exist */
const spa = path.join(root, "artifacts", "egytrend", "dist", "public", "index.html");
const api = path.join(root, "artifacts", "api-server", "dist", "index-bridge.mjs");
if (!fs.existsSync(spa)) fail(`missing SPA output: ${path.relative(root, spa)}`);
if (!fs.existsSync(api)) fail(`missing API bridge bundle: ${path.relative(root, api)}`);

console.log("\n✔ EgyTrend build complete — SPA + API bridge ready for Vercel");
