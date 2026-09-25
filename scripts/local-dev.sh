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
BUN="/c/Users/TBARK/AppData/Local/Programs/@codebufffreebuff-desktop/resources/bun/bun.exe"
PG_BIN="/c/Users/TBARK/pg16/bin"
PG_DATA="/c/Users/TBARK/pg16-data"
LOG_DIR="$ROOT/.local-logs"
mkdir -p "$LOG_DIR"

export PATH="$PG_BIN:$PATH"

# 1. PostgreSQL
if ! "$PG_BIN/pg_ctl.exe" -D "$PG_DATA" status >/dev/null 2>&1; then
  echo "[dev] starting PostgreSQL..."
  "$PG_BIN/pg_ctl.exe" -D "$PG_DATA" -l "$PG_DATA/server.log" -o "-p 5432" start >/dev/null 2>&1
  sleep 2
fi
echo "[dev] PostgreSQL: $( "$PG_BIN/pg_ctl.exe" -D "$PG_DATA" status >/dev/null 2>&1 && echo running || echo DOWN )"

# 2. API server (kill previous instance if any)
if [ -f "$LOG_DIR/api.pid" ] && kill -0 "$(cat "$LOG_DIR/api.pid")" 2>/dev/null; then
  echo "[dev] API already running (pid $(cat "$LOG_DIR/api.pid"))"
else
  echo "[dev] starting API server on :8080 ..."
  (cd "$ROOT/artifacts/api-server" && \
    PORT=8080 \
    DATABASE_URL="postgres://postgres@localhost:5432/egytrend" \
    SESSION_SECRET="${SESSION_SECRET:-local-dev-secret}" \
    ADMIN_PASSWORD="${ADMIN_PASSWORD:-egytrend2026}" \
    NODE_ENV=development \
    nohup "$BUN" --enable-source-maps dist/index.mjs > "$LOG_DIR/api.log" 2>&1 < /dev/null &
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
    nohup "$BUN" node_modules/vite/bin/vite.js --config vite.config.ts > "$LOG_DIR/web.log" 2>&1 < /dev/null &
    echo $! > "$LOG_DIR/web.pid")
  sleep 4
fi

echo "[dev] done. Web UI: http://localhost:3000  |  API: http://localhost:8080/api/healthz"
echo "[dev] logs: $LOG_DIR/api.log, $LOG_DIR/web.log"
