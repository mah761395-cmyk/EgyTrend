#!/usr/bin/env node
/**
 * Read-only production preflight for the non-payment parts of EgyTrend.
 *
 * It deliberately never prints environment values, URLs, API keys, contract
 * references, or passwords. It does not connect to a database or any provider.
 * Run before a Vercel Preview/Production deployment:
 *
 *   node scripts/verify-live-readiness.mjs
 *   node scripts/verify-live-readiness.mjs --full-nonpayment
 *
 * `--full-nonpayment` additionally verifies mail and scheduled-job secrets.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fullNonPayment = process.argv.includes("--full-nonpayment");
const jsonOutput = process.argv.includes("--json");

/** Read .env without executing it and without overriding dashboard/CI values. */
function loadLocalEnvIfPresent() {
  const envFile = path.join(projectRoot, ".env");
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (
      !match ||
      line.trimStart().startsWith("#") ||
      process.env[match[1]] !== undefined
    )
      continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadLocalEnvIfPresent();

const checks = [];
function check(id, required, detail) {
  checks.push({ id, required, ok: Boolean(required), detail });
}

function value(name) {
  return (process.env[name] || "").trim();
}

function looksLikePlaceholder(candidate) {
  return (
    !candidate ||
    /(?:^|[-_.:@/])(change[-_ ]?me|replace|your|example|test|password|secret|database_(?:user|password|host))(?:$|[-_.:@/])/i.test(
      candidate,
    )
  );
}

function hasSafeSecret(name, minimumLength = 32) {
  const candidate = value(name);
  return candidate.length >= minimumLength && !looksLikePlaceholder(candidate);
}

function isProductionBaseUrl(raw) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !looksLikePlaceholder(url.hostname)
    );
  } catch {
    return false;
  }
}

function isPostgresUrl(raw) {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      Boolean(url.hostname) &&
      !looksLikePlaceholder(url.hostname) &&
      !looksLikePlaceholder(url.username) &&
      !looksLikePlaceholder(url.password)
    );
  } catch {
    return false;
  }
}

function isSenderAddress(raw) {
  const address = (raw.match(/<([^>]+)>/)?.[1] || raw).trim();
  const at = address.lastIndexOf("@");
  return (
    at > 0 &&
    at < address.length - 1 &&
    !looksLikePlaceholder(address.slice(at + 1))
  );
}

function parseSymbolMap(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const entries = Object.entries(parsed).filter(
      ([key, symbol]) =>
        typeof key === "string" &&
        key.trim().length > 0 &&
        typeof symbol === "string" &&
        symbol.trim().length > 0,
    );
    return entries.length ? entries : null;
  } catch {
    return null;
  }
}

function catalogInstrumentIds() {
  try {
    const catalog = fs.readFileSync(
      path.join(
        projectRoot,
        "artifacts/api-server/src/lib/market-data/catalog.ts",
      ),
      "utf8",
    );
    return new Set(
      [...catalog.matchAll(/\{ id: "([^"]+)"/g)].map((match) => match[1]),
    );
  } catch {
    return new Set();
  }
}

check(
  "node-env",
  value("NODE_ENV") === "production",
  "NODE_ENV must be production.",
);
check(
  "database-url",
  isPostgresUrl(value("DATABASE_URL")),
  "DATABASE_URL must be a non-placeholder PostgreSQL URL.",
);
check(
  "session-secret",
  hasSafeSecret("SESSION_SECRET", 32),
  "SESSION_SECRET must be a non-placeholder random secret of at least 32 characters.",
);
check(
  "admin-password",
  hasSafeSecret("ADMIN_PASSWORD", 16),
  "ADMIN_PASSWORD must be a non-placeholder strong password of at least 16 characters.",
);
check(
  "app-base-url",
  isProductionBaseUrl(value("APP_BASE_URL")),
  "APP_BASE_URL must be a real HTTPS application URL.",
);

check(
  "twelve-api-key",
  value("TWELVE_DATA_API_KEY").length >= 8 &&
    !looksLikePlaceholder(value("TWELVE_DATA_API_KEY")),
  "TWELVE_DATA_API_KEY is required but is never printed.",
);
check(
  "twelve-external-display-license",
  value("TWELVE_DATA_EXTERNAL_DISPLAY_LICENSED") === "true",
  "Set only after written external-display/redistribution approval.",
);
check(
  "twelve-license-reference",
  value("TWELVE_DATA_LICENSE_REFERENCE").length >= 4 &&
    !looksLikePlaceholder(value("TWELVE_DATA_LICENSE_REFERENCE")),
  "A non-secret contract, order, or approval reference is required.",
);

const delayRaw = value("TWELVE_DATA_DELAY_MINUTES");
const delay = /^\d+(?:\.\d+)?$/.test(delayRaw) ? Number(delayRaw) : Number.NaN;
check(
  "twelve-delay-classification",
  Number.isFinite(delay) && delay >= 0,
  "TWELVE_DATA_DELAY_MINUTES must be an explicit non-negative number from the agreement.",
);
check(
  "twelve-realtime-rights",
  Number.isFinite(delay) &&
    delay >= 0 &&
    (delay !== 0 || value("TWELVE_DATA_REALTIME_DISPLAY_LICENSED") === "true"),
  "A zero-delay quote also requires TWELVE_DATA_REALTIME_DISPLAY_LICENSED=true after written approval.",
);

const symbolMap = parseSymbolMap(value("TWELVE_DATA_SYMBOLS_JSON"));
check(
  "twelve-symbol-map",
  Boolean(symbolMap),
  "TWELVE_DATA_SYMBOLS_JSON must be a non-empty JSON object of contract-confirmed vendor symbols.",
);
if (symbolMap) {
  const knownIds = catalogInstrumentIds();
  const unknownIds = knownIds.size
    ? symbolMap.filter(([id]) => !knownIds.has(id)).length
    : 0;
  check(
    "twelve-symbol-map-catalog",
    unknownIds === 0,
    unknownIds === 0
      ? "Every configured map key is an instrument in the repository catalog."
      : "One or more map keys are not in the repository catalog; do not deploy until corrected.",
  );

  const hasEgxMapping = symbolMap.some(
    ([id]) => id.startsWith("egx:") || id.startsWith("stock:egx:"),
  );
  check(
    "twelve-egx-display-license",
    !hasEgxMapping || value("TWELVE_DATA_EGX_DISPLAY_LICENSED") === "true",
    hasEgxMapping
      ? "Every EGX mapping requires its own written coverage/redistribution acknowledgement."
      : "No EGX mapping is requested, so the EGX-specific acknowledgement remains unused.",
  );
  check(
    "twelve-egx-license-reference",
    !hasEgxMapping ||
      (value("TWELVE_DATA_EGX_LICENSE_REFERENCE").length >= 4 &&
        !looksLikePlaceholder(value("TWELVE_DATA_EGX_LICENSE_REFERENCE"))),
    hasEgxMapping
      ? "Every EGX mapping requires a non-secret EGX-specific contract or approval reference."
      : "No EGX mapping is requested, so the EGX-specific reference remains unused.",
  );
}

if (fullNonPayment) {
  check(
    "smtp-host",
    value("SMTP_HOST").length > 0,
    "SMTP_HOST is required for password-recovery and operational mail.",
  );
  check(
    "smtp-user",
    value("SMTP_USER").length > 0,
    "SMTP_USER is required for password-recovery and operational mail.",
  );
  check(
    "smtp-password",
    hasSafeSecret("SMTP_PASS", 12),
    "SMTP_PASS must be non-placeholder and is never printed.",
  );
  check(
    "smtp-from",
    isSenderAddress(value("SMTP_FROM")),
    "SMTP_FROM must contain a non-placeholder sender address.",
  );
  check(
    "protected-scheduler-cron-secret",
    hasSafeSecret("CRON_SECRET", 24),
    "CRON_SECRET is required before enabling price-alert or subscription-lifecycle jobs.",
  );

  const snapshotsEnabled = value("MARKET_SNAPSHOT_WRITES_ENABLED") === "true";
  check(
    "market-snapshot-cron-secret",
    !snapshotsEnabled || hasSafeSecret("MARKET_SNAPSHOT_CRON_SECRET", 24),
    snapshotsEnabled
      ? "MARKET_SNAPSHOT_CRON_SECRET is required while snapshot writes are enabled."
      : "Snapshot writes remain disabled; no production database write is scheduled.",
  );
}

const blocked = checks.filter((item) => !item.ok);
if (jsonOutput) {
  process.stdout.write(
    `${JSON.stringify(
      {
        scope: fullNonPayment ? "full-nonpayment" : "core-nonpayment",
        ready: blocked.length === 0,
        checks: checks.map(({ id, ok, detail }) => ({ id, ok, detail })),
      },
      null,
      2,
    )}\n`,
  );
} else {
  console.log(
    `Read-only ${fullNonPayment ? "full non-payment" : "core non-payment"} readiness check`,
  );
  for (const item of checks)
    console.log(`${item.ok ? "OK" : "BLOCKED"}  ${item.id} — ${item.detail}`);
  console.log(
    blocked.length
      ? `\nResult: BLOCKED (${blocked.length} item${blocked.length === 1 ? "" : "s"}). No secret values were printed.`
      : "\nResult: READY. No secret values were printed.",
  );
}

process.exitCode = blocked.length ? 1 : 0;
