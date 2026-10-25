/**
 * EgyTrend — Vercel build script (runs on Vercel's Linux build machine).
 *
 * Vercel build images have Node but NOT pnpm preinstalled. corepack ships
 * with every Node ≥ 16, so we activate pnpm through it, then build the whole
 * monorepo exactly like locally (`pnpm run build`).
 *
 * Steps (invoked by vercel.json buildCommand = "node vercel-build.mjs"):
 *   1. resolve the Corepack-pinned pnpm (with a process-local shim if needed)
 *   2. pnpm install --frozen-lockfile (root install covers all workspaces)
 *   3. pnpm run build → typecheck + libs + api-server esbuild bundle + SPA
 *   4. sanity-check the two outputs Vercel will serve:
 *        artifacts/egytrend/dist/public/index.html      (public static entry)
 *        artifacts/egytrend/dist/public/admin.html      (isolated admin entry)
 *        artifacts/api-server/dist/index-bridge.mjs     (serverless API entry)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

/* 1. make sure pnpm exists. Vercel normally exposes Corepack's pnpm shim,
 * but `corepack enable` writes into the Node install directory and fails on
 * locked-down/non-root build images. If pnpm is absent, install a tiny
 * process-local shim which delegates to the version pinned in packageManager.
 * Keeping it on PATH also lets nested package scripts (`pnpm run …`) work. */
const hasPnpm = spawnSync("pnpm", ["--version"], { stdio: "ignore", shell: false }).status === 0;
if (!hasPnpm) {
  if (spawnSync("corepack", ["--version"], { stdio: "ignore", shell: false }).status !== 0) {
    fail("pnpm is unavailable and Corepack is not installed");
  }
  console.log("◆ pnpm not found — using a process-local Corepack shim…");
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "egytrend-pnpm-"));
  const shim = path.join(shimDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  if (process.platform === "win32") {
    fs.writeFileSync(shim, "@echo off\r\ncorepack pnpm %*\r\n", "utf8");
  } else {
    fs.writeFileSync(shim, "#!/bin/sh\nexec corepack pnpm \"$@\"\n", { encoding: "utf8", mode: 0o755 });
  }
  process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH || ""}`;
  if (spawnSync("pnpm", ["--version"], { stdio: "inherit", shell: false, env: process.env }).status !== 0) {
    fail("could not start pnpm through Corepack");
  }
}

/* 2. install every workspace from the lockfile (root install = all packages) */
run("pnpm", ["install", "--frozen-lockfile"]);

/* 3. build all workspaces: typecheck + libs + API bundle + SPA
 *    (workspaces whose build needs only node resolve normally; pnpm itself is
 *    already alive via corepack — the fallbacks in package.json cover the rest) */
run("pnpm", ["run", "build"]);

/* 4. every static/serverless entry Vercel serves must exist */
const publicEntry = path.join(root, "artifacts", "egytrend", "dist", "public", "index.html");
const adminEntry = path.join(root, "artifacts", "egytrend", "dist", "public", "admin.html");
const api = path.join(root, "artifacts", "api-server", "dist", "index-bridge.mjs");
if (!fs.existsSync(publicEntry)) fail(`missing public entry: ${path.relative(root, publicEntry)}`);
if (!fs.existsSync(adminEntry)) fail(`missing admin entry: ${path.relative(root, adminEntry)}`);
if (!fs.existsSync(api)) fail(`missing API bridge bundle: ${path.relative(root, api)}`);

console.log("\n✔ EgyTrend build complete — public + admin entries and API bridge ready for Vercel");
