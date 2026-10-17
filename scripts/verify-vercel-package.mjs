/*
 * Vercel serverless package sanity check.
 *
 * The API entry dynamically imports artifacts/api-server/dist/index-bridge.mjs.
 * Keep the Vercel includeFiles rule narrow and verify that the build is fully
 * self-contained: no entire pnpm store, no runtime-only bare dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "artifacts", "api-server", "dist");
const staticDist = path.join(root, "artifacts", "egytrend", "dist", "public");
const bridge = path.join(dist, "index-bridge.mjs");
const bundle = path.join(dist, "index.mjs");
const vercelIgnore = path.join(root, ".vercelignore");
const MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;

function fail(message) {
  console.error(`✖ Vercel package check: ${message}`);
  process.exitCode = 1;
}

function sizeOf(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) size += sizeOf(full);
    else if (entry.isFile()) size += fs.statSync(full).size;
  }
  return size;
}

function filesUnder(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

for (const file of [bridge, bundle, staticDist]) {
  if (!fs.existsSync(file)) fail(`missing ${path.relative(root, file)}; run pnpm run build first`);
}

if (!process.exitCode) {
  const bridgeText = fs.readFileSync(bridge, "utf8");
  const bundleText = fs.readFileSync(bundle, "utf8");
  const bytes = sizeOf(dist);

  /* `attached_assets/` holds unreviewed historical uploads. The Vercel build
   * output does not depend on it, and the upload exclusion prevents a future
   * packaging change from accidentally shipping its obsolete payment/admin UI. */
  if (!fs.existsSync(vercelIgnore) || !/(?:^|\n)attached_assets\/\s*(?:\n|$)/.test(fs.readFileSync(vercelIgnore, "utf8"))) {
    fail(".vercelignore must exclude attached_assets/");
  }

  if (!bridgeText.includes('specifier = "./index.mjs"')) {
    fail("API bridge no longer resolves the bundled index.mjs relative to itself");
  }
  if (/from\s+["']nodemailer["']|import\(["']nodemailer["']\)/.test(bundleText)) {
    fail("API bundle still has a bare nodemailer runtime import; Vercel would need node_modules");
  }
  const forbiddenStaticMarkers = [
    /x-admin-token/i,
    /ADMIN_TOKEN/,
    /egytrend2026/i,
  ];
  for (const file of filesUnder(staticDist)) {
    if (!/\.(?:html|js|css|json|txt)$/i.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (forbiddenStaticMarkers.some((marker) => marker.test(text))) {
      fail(`static release output contains a retired admin credential marker: ${path.relative(root, file)}`);
      break;
    }
  }
  if (bytes > MAX_UNCOMPRESSED_BYTES) {
    fail(`dist is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the 250 MB Vercel function limit`);
  }

  if (!process.exitCode) {
    console.log(`✔ Vercel package check: ${path.relative(root, dist)} is ${(bytes / 1024 / 1024).toFixed(2)} MB and self-contained`);
  }
}
