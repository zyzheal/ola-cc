#!/usr/bin/env bash
# Write worktree progress to the shared progress file.
# Usage: ./report-progress.sh "task name" "current step" 45 "running"
#
# Called by worktree agents to report their status to the main session.

GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PROGRESS_FILE="$GIT_ROOT/.worktrees-progress.json"
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")

TASK="${1:-initializing}"
STEP="${2:-starting}"
PROGRESS="${3:-0}"
STATUS="${4:-running}"
HEARTBEAT=$(date +%s000)

# Read existing entries or create empty array
if [ -f "$PROGRESS_FILE" ]; then
  ENTRIES=$(cat "$PROGRESS_FILE")
else
  ENTRIES="[]"
fi

# Update or add entry using a simple approach
# Remove existing entry for this branch, then add new one
NEW_ENTRY="{\"branch\":\"$BRANCH\",\"task\":\"$TASK\",\"currentStep\":\"$STEP\",\"progress\":$PROGRESS,\"status\":\"$STATUS\",\"heartbeat\":$HEARTBEAT,\"workdir\":\"$(pwd)\"}"

# Use node for JSON manipulation if available, otherwise use simple approach
if command -v node &>/dev/null; then
  echo "$ENTRIES" | node -e "
    const stdin = require('fs').readFileSync('/dev/stdin', 'utf8').trim();
    let entries = [];
    try { entries = JSON.parse(stdin); } catch(e) {}
    const newEntry = $(echo "$NEW_ENTRY" | sed 's/"/\\"/g');
    const idx = entries.findIndex(e => e.branch === '$BRANCH');
    if (idx >= 0) entries[idx] = $(echo "$NEW_ENTRY");
    else entries.push($(echo "$NEW_ENTRY"));
    console.log(JSON.stringify(entries, null, 2));
  " > "$PROGRESS_FILE"
else
  # Fallback: just write the single entry
  echo "[$NEW_ENTRY]" > "$PROGRESS_FILE"
fi
