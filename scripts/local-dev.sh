#!/usr/bin/env bash
# Local dev launcher for EgyTrend on Windows (Git Bash + bundled bun runtime).
# Starts PostgreSQL (if not running), the API server (port 8080), and the
# Vite dev server (port 3000, proxies /api -> 8080).
set -u

# Git Bash quirk: MSYS converts "/"-valued env vars to Windows paths when
# spawning native exes (e.g. BASE_PATH="/" -> "C:/Program Files/Git/").
export MSYS2_ENV_CONV_EXCL="*"
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Prefer a caller-supplied runtime. If none is supplied, use Bun or Node from
# PATH. Never commit a machine-specific executable path here.
RUNTIME="${RUNTIME_BIN:-${BUN_BIN:-}}"
if [ -z "$RUNTIME" ]; then
  RUNTIME="$(command -v bun 2>/dev/null || command -v node 2>/dev/null || true)"
fi
if [ -z "$RUNTIME" ]; then
  echo "[dev] Bun or Node is required (or set RUNTIME_BIN/BUN_BIN)." >&2
  exit 1
fi

# Never launch even a local authenticated API with a checked-in/default signing
# key. Supply a unique development-only value through the shell or secret
# manager; do not paste it into this script, a commit, or a log.
if [ -z "${SESSION_SECRET:-}" ]; then
  echo "[dev] SESSION_SECRET is required (use a unique development-only value)." >&2
  exit 1
fi

# PostgreSQL startup is optional and intentionally machine-configured. When
# PG_BIN and PG_DATA are absent, the script leaves an already-running local DB
# alone rather than embedding a personal filesystem path.
PG_BIN="${PG_BIN:-}"
PG_DATA="${PG_DATA:-}"
LOG_DIR="$ROOT/.local-logs"
mkdir -p "$LOG_DIR"

# 1. PostgreSQL (only when the caller explicitly supplies local control paths)
if [ -n "$PG_BIN" ] && [ -n "$PG_DATA" ]; then
  if [ -x "$PG_BIN/pg_ctl.exe" ]; then PG_CTL="$PG_BIN/pg_ctl.exe"; else PG_CTL="$PG_BIN/pg_ctl"; fi
  if [ ! -x "$PG_CTL" ]; then
    echo "[dev] PG_BIN does not contain pg_ctl: $PG_BIN" >&2
    exit 1
  fi
  export PATH="$PG_BIN:$PATH"
  if ! "$PG_CTL" -D "$PG_DATA" status >/dev/null 2>&1; then
    echo "[dev] starting PostgreSQL..."
    "$PG_CTL" -D "$PG_DATA" -l "$PG_DATA/server.log" -o "-p 5432" start >/dev/null 2>&1
    sleep 2
  fi
  echo "[dev] PostgreSQL: $( "$PG_CTL" -D "$PG_DATA" status >/dev/null 2>&1 && echo running || echo DOWN )"
else
  echo "[dev] PostgreSQL startup not managed; using the configured/local DATABASE_URL. Set PG_BIN and PG_DATA only to manage a local instance."
fi

# 2. API server (kill previous instance if any)
if [ -f "$LOG_DIR/api.pid" ] && kill -0 "$(cat "$LOG_DIR/api.pid")" 2>/dev/null; then
  echo "[dev] API already running (pid $(cat "$LOG_DIR/api.pid"))"
else
  echo "[dev] starting API server on :8080 ..."
  (cd "$ROOT/artifacts/api-server" && \
    export PORT=8080 DATABASE_URL="postgres://postgres@localhost:5432/egytrend" SESSION_SECRET NODE_ENV=development && \
    # `ADMIN_PASSWORD` is optional and only enables the short-lived break-glass
    # bootstrap route. Normal local testing uses an employee account instead.
    if [ -n "${ADMIN_PASSWORD:-}" ]; then export ADMIN_PASSWORD; else unset ADMIN_PASSWORD; fi && \
    nohup "$RUNTIME" --enable-source-maps dist/index.mjs > "$LOG_DIR/api.log" 2>&1 < /dev/null &
    echo $! > "$LOG_DIR/api.pid")
  sleep 2
fi

# 3. Frontend dev server
if [ -f "$LOG_DIR/web.pid" ] && kill -0 "$(cat "$LOG_DIR/web.pid")" 2>/dev/null; then
  echo "[dev] Web already running (pid $(cat "$LOG_DIR/web.pid"))"
else
  echo "[dev] starting Vite dev server on :3000 ..."
  (cd "$ROOT/artifacts/egytrend" && \
    PORT=3000 BASE_PATH="/" API_PROXY_TARGET="http://localhost:8080" \
    nohup "$RUNTIME" node_modules/vite/bin/vite.js --config vite.config.ts > "$LOG_DIR/web.log" 2>&1 < /dev/null &
    echo $! > "$LOG_DIR/web.pid")
  sleep 4
fi

echo "[dev] done. Web UI: http://localhost:3000  |  API: http://localhost:8080/api/healthz"
echo "[dev] logs: $LOG_DIR/api.log, $LOG_DIR/web.log"
