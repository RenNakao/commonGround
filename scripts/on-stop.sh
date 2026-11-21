#!/usr/bin/env bash
# Claude Code Stop hook: doclinks review first, then auto-deploy.
#
# Order matters: deploy.sh commits the working tree, and doclinks reviews *uncommitted* changes.
# If doclinks blocks (linked docs to review, broken citations, stale links.json), the agent continues,
# and the deploy runs at the next stop, when stop_hook_active is true and doclinks stays quiet.
set -uo pipefail
cd "$(dirname "$0")/.."

INPUT=$(cat || true)
REVIEW=$(printf '%s' "$INPUT" | node tools/doclinks.mjs hook-stop 2>/dev/null || true)
if [ -n "$REVIEW" ]; then
  printf '%s\n' "$REVIEW"
  exit 0
fi
printf '%s' "$INPUT" | bash scripts/deploy.sh
