#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/logs/design-hub.log"
PID_FILE="$SCRIPT_DIR/design-hub.pid"
ENV_FILE="$SCRIPT_DIR/.env"
LAUNCH_LABEL="com.ghost.design-hub"
LAUNCH_DOMAIN="gui/$(id -u)"
LAUNCH_PLIST="$SCRIPT_DIR/.global/$LAUNCH_LABEL.plist"
HOST="${DESIGN_HUB_HOST:-0.0.0.0}"
PORT="${DESIGN_HUB_PORT:-8765}"
NO_TAIL=0
QUIET=0
STARTED_NEW=0
CURRENT_PID=""

usage() {
  printf '%s\n' 'Usage: ./start_server.sh [--no-tail] [--quiet] [--help]'
}

info() {
  [[ "$QUIET" == "1" ]] || printf '[INFO] %s\n' "$*"
}

fail() {
  printf '[ERR] %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-tail) NO_TAIL=1 ;;
    --quiet) QUIET=1 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

command -v python3 >/dev/null 2>&1 || fail 'python3 is required'
command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v lsof >/dev/null 2>&1 || fail 'lsof is required'

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

HOST="${DESIGN_HUB_HOST:-$HOST}"
PORT="${DESIGN_HUB_PORT:-$PORT}"
[[ "$PORT" =~ ^[0-9]+$ ]] || fail "invalid port: $PORT"

mkdir -p "$SCRIPT_DIR/logs" "$SCRIPT_DIR/data"
touch "$LOG_FILE"

running_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local service_pid
  service_pid="$(<"$PID_FILE")"
  [[ "$service_pid" =~ ^[0-9]+$ ]] && kill -0 "$service_pid" 2>/dev/null || return 1
  printf '%s' "$service_pid"
}

health_ok() {
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1
}

cleanup() {
  if [[ "$STARTED_NEW" == "1" ]]; then
    info "stopping Design Hub pid=$CURRENT_PID"
    launchctl bootout "$LAUNCH_DOMAIN/$LAUNCH_LABEL" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
}

existing_pid="$(running_pid || true)"
if [[ -n "$existing_pid" ]]; then
  health_ok || fail "pid file exists but health check failed: $existing_pid"
  info "Design Hub already running pid=$existing_pid"
  [[ "$NO_TAIL" == "1" ]] && exit 0
  tail -n 0 -F "$LOG_FILE"
  exit 0
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  fail "port $PORT is already in use"
fi

if [[ ! -f "$SCRIPT_DIR/data/design-hub.sqlite3" && -z "${DESIGN_HUB_ADMIN_PASSWORD:-}" ]]; then
  fail "first start requires DESIGN_HUB_ADMIN_PASSWORD in $ENV_FILE"
fi

info "starting Design Hub on $HOST:$PORT"
mkdir -p "$(dirname "$LAUNCH_PLIST")"
launchctl bootout "$LAUNCH_DOMAIN/$LAUNCH_LABEL" 2>/dev/null || true
python3 - "$LAUNCH_PLIST" "$(command -v python3)" "$SCRIPT_DIR/server/app.py" "$SCRIPT_DIR" "$LOG_FILE" "$HOST" "$PORT" "${DESIGN_HUB_ADMIN_USERNAME:-admin}" "${DESIGN_HUB_ADMIN_PASSWORD:-}" "${DESIGN_HUB_MAX_UPLOAD_MB:-150}" <<'PY'
import plistlib, sys
plist, python, app, cwd, log, host, port, username, password, upload_mb = sys.argv[1:]
payload = {
    "Label": "com.ghost.design-hub",
    "ProgramArguments": [python, "-u", app],
    "WorkingDirectory": cwd,
    "EnvironmentVariables": {
        "DESIGN_HUB_HOST": host,
        "DESIGN_HUB_PORT": port,
        "DESIGN_HUB_ADMIN_USERNAME": username,
        "DESIGN_HUB_ADMIN_PASSWORD": password,
        "DESIGN_HUB_MAX_UPLOAD_MB": upload_mb,
    },
    "RunAtLoad": True,
    "StandardOutPath": log,
    "StandardErrorPath": log,
}
with open(plist, "wb") as handle:
    plistlib.dump(payload, handle)
PY
launchctl bootstrap "$LAUNCH_DOMAIN" "$LAUNCH_PLIST"
STARTED_NEW=1

for _ in {1..25}; do
  CURRENT_PID="$(launchctl print "$LAUNCH_DOMAIN/$LAUNCH_LABEL" 2>/dev/null | awk '/pid =/ {print $3; exit}')"
  if [[ -n "$CURRENT_PID" ]] && health_ok; then
    printf '%s\n' "$CURRENT_PID" >"$PID_FILE"
    info "ready: http://127.0.0.1:$PORT"
    if [[ "$NO_TAIL" == "1" ]]; then
      STARTED_NEW=0
      exit 0
    fi
    trap cleanup INT TERM EXIT
    tail -n 0 -F "$LOG_FILE"
    exit 0
  fi
  sleep 1
done

cleanup
fail 'service did not become healthy within 25 seconds'
