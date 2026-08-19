#!/bin/bash
# Build several games in sequence through the real Code workflow, play-test each,
# and keep going after a failure so one bad game does not end the run.
set -uo pipefail
ROOT=/Users/adam/LocalHarness
LIST="$ROOT/.overnight/stress-games.txt"
SUM="$ROOT/.overnight/stress-summary.txt"
: > "$SUM"

while IFS='|' read -r NAME PROMPT; do
  [ -z "$NAME" ] && continue
  WS="$ROOT/.overnight/g-$NAME"
  rm -rf "$WS"; mkdir -p "$WS"
  echo "=== $NAME  $(date '+%H:%M:%S') ===" | tee -a "$SUM"

  /usr/bin/python3 - "$NAME" "$PROMPT" <<'PY' > "$ROOT/.overnight/task-$NAME.json"
import json, sys
print(json.dumps({"name": sys.argv[1], "prompt": sys.argv[2]}))
PY

  node "$ROOT/scripts/code-bench.mjs" --task custom --prompt-file "$ROOT/.overnight/task-$NAME.json" \
    --skip-load --workspace "$WS" --timeout 900000 > "$ROOT/.overnight/stress-$NAME.log" 2>&1

  F=$(find "$WS" -maxdepth 1 -name '*.html' -size +2k | head -1)
  if [ -n "$F" ]; then
    BYTES=$(wc -c < "$F")
    echo "  built $(basename "$F") $BYTES bytes" | tee -a "$SUM"
    node "$ROOT/scripts/overnight/play-test.mjs" "$F" > "$ROOT/.overnight/play-$NAME.log" 2>&1
    grep -E "PLAYS|PROBLEM" "$ROOT/.overnight/play-$NAME.log" | tail -1 | sed 's/^/  /' | tee -a "$SUM"
  else
    echo "  NOTHING BUILT" | tee -a "$SUM"
  fi
  grep -E "^  turn " "$ROOT/.overnight/stress-$NAME.log" | tr -d '\r' | tail -3 | tee -a "$SUM"
done < "$LIST"
echo "done $(date '+%H:%M:%S')" | tee -a "$SUM"
