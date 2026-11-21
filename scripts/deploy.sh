#!/usr/bin/env bash
# Build and deploy the app to Cloudflare Workers.
#
# Runs as a Claude Code Stop hook (see .claude/settings.json) at the end of
# every agent turn, and can be run by hand: `npm run ship`.
#
#   1. Commit any pending changes (git log doubles as a log of agent turns).
#   2. If HEAD differs from the last deployed commit, build + `wrangler deploy`.
#   3. On build/deploy failure inside a hook, exit 2 so Claude sees the error and
#      fixes it — at most MAX_FIX_ROUNDS times in a row, to avoid loops.
set -uo pipefail

cd "$(dirname "$0")/.."

HOOK_INPUT=""
if [ ! -t 0 ]; then HOOK_INPUT=$(cat || true); fi
IN_HOOK=0; [ -n "$HOOK_INPUT" ] && IN_HOOK=1
MAX_FIX_ROUNDS=3
FAILS=.wrangler/failed-rounds  # consecutive failed deploys handed back to Claude

say() {  # message for the user's transcript (hook) or the terminal (manual)
  if [ "$IN_HOOK" = 1 ]; then
    node -e 'console.log(JSON.stringify({systemMessage: process.argv[1]}))' "$1"
  else
    echo "$1"
  fi
}

fail() {  # $1 = summary, $2 = log file
  local n; n=$(( $(cat "$FAILS" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$FAILS"
  if [ "$IN_HOOK" = 1 ] && [ "$n" -le "$MAX_FIX_ROUNDS" ]; then
    { echo "$1 — fix the error below; the deploy will re-run automatically when you finish."; tail -40 "$2"; } >&2
    exit 2
  fi
  say "⚠️ $1 (see $2)"
  exit 0
}

mkdir -p .wrangler
if [ -f .env ]; then set -a; . ./.env; set +a; fi
# An empty token makes wrangler ignore the OAuth login, so drop it.
[ -z "${CLOUDFLARE_API_TOKEN:-}" ] && unset CLOUDFLARE_API_TOKEN

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -qm "auto: $(date '+%Y-%m-%d %H:%M:%S')" || true
fi

HEAD=$(git rev-parse HEAD 2>/dev/null || echo none)
MARKER=.wrangler/last-deploy
mkdir -p .wrangler
if [ "$HEAD" = "$(cat "$MARKER" 2>/dev/null)" ] && [ "${FORCE:-0}" != 1 ]; then
  exit 0  # nothing new since the last deploy
fi

LOG=.wrangler/deploy.log
if ! npm run build >"$LOG" 2>&1; then fail "Build failed" "$LOG"; fi
if ! npx wrangler deploy >>"$LOG" 2>&1; then fail "Deploy failed" "$LOG"; fi

echo "$HEAD" > "$MARKER"
rm -f "$FAILS"
URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' "$LOG" | tail -1)
say "🚀 Deployed $(git rev-parse --short HEAD) → ${URL:-Cloudflare}"
