#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_PATH="$SCRIPT_DIR/autoresearch.jsonl"

if [ ! -f "$SESSION_PATH" ]; then
  printf 'Demo session file not found: %s\n' "$SESSION_PATH" >&2
  exit 1
fi

LAST_RUN="$(awk '/"run"[[:space:]]*:/ { line = $0 } END { if (line) print line }' "$SESSION_PATH")"
if [ -z "$LAST_RUN" ]; then
  printf 'The demo session does not contain any runs to replay.\n' >&2
  exit 1
fi

RUN_ID="$(printf '%s\n' "$LAST_RUN" | sed -E 's/.*"run"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/')"
SECONDS_VALUE="$(printf '%s\n' "$LAST_RUN" | sed -E 's/.*"metric"[[:space:]]*:[[:space:]]*([-0-9.]+).*/\1/')"
MEMORY_MB="$(printf '%s\n' "$LAST_RUN" | sed -E 's/.*"memory_mb"[[:space:]]*:[[:space:]]*([-0-9.]+).*/\1/')"

printf 'METRIC seconds=%s\n' "$SECONDS_VALUE"
if [ "$MEMORY_MB" != "$LAST_RUN" ]; then
  printf 'METRIC memory_mb=%s\n' "$MEMORY_MB"
fi

printf 'Replayed demo packet #%s from the embedded run log.\n' "$RUN_ID"
