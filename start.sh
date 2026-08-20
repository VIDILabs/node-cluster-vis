#!/usr/bin/env bash
#
# Start the backend and the frontend together, in one terminal.
#
#   ./start.sh              # both
#   ./start.sh --api-only   # Flask only
#   ./start.sh --ui-only    # CRA only (expects an API already running)
#
# Ctrl-C stops everything it started. Output from both is prefixed and
# interleaved. Setup is *not* done here: see README.md.

set -euo pipefail

# Anchor to the script's own directory, not the caller's CWD — the same rule
# server/config.py follows, so the script works from anywhere.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

API_HOST="${NCV_HOST:-127.0.0.1}"
API_PORT="${NCV_PORT:-5010}"
UI_PORT="${PORT:-3000}"
RUN_API=1
RUN_UI=1

while [ $# -gt 0 ]; do
  case "$1" in
    --api-only) RUN_UI=0 ;;
    --ui-only)  RUN_API=0 ;;
    -h|--help)  awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "start.sh: unknown option '$1' (try --help)" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "start.sh: $*" >&2; exit 1; }
note() { printf '\033[2m[start]\033[0m %s\n' "$*"; }

port_busy() {
  # No single portable listener check: try each tool, skip the check if none.
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
  else
    return 1
  fi
}

# --- preflight ---------------------------------------------------------------
# Fail before starting anything, so a half-up stack never happens.

if [ "$RUN_API" = 1 ]; then
  [ -f "$ROOT/server/.venv/bin/activate" ] || die "no virtualenv at server/.venv — see README.md (Backend > Setup)"
  port_busy "$API_PORT" && die "port $API_PORT is already in use; stop the running API or set NCV_PORT"
  # ccpca is deliberately absent from requirements.txt (it needs a local build),
  # so a fresh venv installs cleanly and then dies on the first /api/dr call.
  # Better to say so now than 4 seconds into the pipeline.
  ( . "$ROOT/server/.venv/bin/activate" && python -c 'import ccpca, fc_view' 2>/dev/null ) \
    || die "the venv has no working 'ccpca' — see README.md (Backend > Setup, step 6)"
fi

if [ "$RUN_UI" = 1 ]; then
  [ -d "$ROOT/ui/node_modules" ] || die "ui/node_modules is missing — run 'npm install' in ui/"
  [ -f "$ROOT/ui/.env.development" ] || die "ui/.env.development is missing — run 'cp .env.example .env.development' in ui/"
  port_busy "$UI_PORT" && die "port $UI_PORT is already in use; stop the running dev server or set PORT"
  node_major="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')"
  [ -n "$node_major" ] || die "node is not on PATH (Node 24+ required)"
  [ "$node_major" -ge 24 ] || note "warning: Node $node_major found, 24+ expected — try 'nvm use 24'"
fi

# --- process management ------------------------------------------------------

PIDS=()

# npm spawns react-scripts, which spawns the dev server: killing the npm pid
# alone orphans the node process still holding port 3000. Walk the tree.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

shutdown() {
  trap - INT TERM EXIT
  note "stopping…"
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill_tree "$pid"; done
  wait 2>/dev/null || true
}
trap shutdown INT TERM EXIT

# Prefix each stream so two servers in one terminal stay readable.
run() {
  local label="$1"; shift
  # A `while read` loop rather than sed or awk: `sed -u` is a GNU extension and
  # this has to run on macOS too, while mawk buffers its *input* and so holds
  # every line until the stream ends — which for a server is never. bash reads a
  # pipe a byte at a time, so lines appear as they are written.
  ( "$@" 2>&1 | while IFS= read -r line; do printf '[%s] %s\n' "$label" "$line"; done ) &
  PIDS+=("$!")
}

# --- go ----------------------------------------------------------------------

if [ "$RUN_API" = 1 ]; then
  note "backend  → http://$API_HOST:$API_PORT"
  # PYTHONUNBUFFERED so a print() reaches the terminal: stdout is a pipe here,
  # and Python block-buffers those.
  run api env PYTHONUNBUFFERED=1 NCV_HOST="$API_HOST" NCV_PORT="$API_PORT" \
    "$ROOT/server/.venv/bin/python" "$ROOT/server/server.py"

  if [ "$RUN_UI" = 1 ]; then
    # Loading the dataset happens before the first request is served, so poll
    # rather than sleeping a guessed amount — a large NCV_DATA_DIR takes a while.
    note "waiting for the API to load its dataset…"
    for _ in $(seq 1 120); do
      curl -sf "http://$API_HOST:$API_PORT/api/health" >/dev/null 2>&1 && break
      kill -0 "${PIDS[0]}" 2>/dev/null || die "the backend exited during startup (see [api] above)"
      sleep 1
    done
  fi
fi

if [ "$RUN_UI" = 1 ]; then
  note "frontend → http://localhost:$UI_PORT"
  run ui env PORT="$UI_PORT" npm --prefix "$ROOT/ui" start
fi

note "Ctrl-C to stop."
wait
