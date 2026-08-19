#!/bin/bash
# Code-mode benchmark across model variants, driven through the real GUI.
#
# One plain, user-style prompt — deliberately NOT engineered. The point is to
# measure what the HARNESS achieves on its own, so anything that only works
# because the prompt was hand-tuned is not a result worth having.
#
#   variant-bench.sh <label> <model-id> <prompt-file> <workspace> <max-seconds>
set -uo pipefail
LABEL="$1"; MODEL="$2"; PROMPT_FILE="$3"; WS="$4"; MAX="${5:-1500}"
ROOT=/Users/adam/LocalHarness
OUT="$ROOT/.overnight/$LABEL"
mkdir -p "$OUT" "$WS"
rm -f "$WS"/*.html 2>/dev/null

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$OUT/log.txt"; }
shot() {
  osascript -e 'tell application "CaptainLlama" to activate' >/dev/null 2>&1
  sleep 1
  screencapture -x -o "$OUT/$1.png" 2>/dev/null
  sips -Z 1250 "$OUT/$1.png" --out "$OUT/$1.s.png" >/dev/null 2>&1
}

say "=== $LABEL — $MODEL ==="

# 1. Put the app down before touching the model, so nothing races for memory.
osascript -e 'tell application "CaptainLlama" to quit' >/dev/null 2>&1
sleep 4

# 2. Load the variant, and pin the app to it.
node "$ROOT/scripts/model-context.mjs" 61440 "$MODEL" 2>&1 | tail -2 | tee -a "$OUT/log.txt"
/usr/bin/python3 - "$MODEL" <<'PY'
import json, os, sys
p = os.path.expanduser('~/Library/Application Support/localharness/settings.json')
d = json.load(open(p))
d['defaultModelId'] = sys.argv[1]
json.dump(d, open(p, 'w'), indent=2)
print('pinned', sys.argv[1])
PY

# 3. Relaunch on Code and let it settle.
(LH_START_WORKFLOW=code nohup /Applications/CaptainLlama.app/Contents/MacOS/CaptainLlama >/dev/null 2>&1 &)
sleep 16
shot 00-launched

osascript -e 'tell application "System Events" to tell process "CaptainLlama" to click menu item "New Conversation" of menu 1 of menu bar item "File" of menu bar 1' >/dev/null 2>&1
sleep 3

"$ROOT/scripts/overnight/drive-ui.sh" "$(cat "$PROMPT_FILE")" >> "$OUT/log.txt" 2>&1 || { say "SEND FAILED"; exit 2; }
sleep 5
shot 01-sent
say "sent"

find_conv() {
  /usr/bin/python3 - <<'PY'
import glob, json, os
d = os.path.expanduser('~/Library/Application Support/localharness/conversations')
for f in sorted(glob.glob(os.path.join(d, '*.json')), key=os.path.getmtime, reverse=True)[:6]:
    try: c = json.load(open(f))
    except Exception: continue
    if c.get('workflowId') == 'code' and any(m.get('role') == 'user' for m in c.get('messages', [])):
        print(f); break
PY
}
CONV=""; for _ in $(seq 1 20); do CONV="$(find_conv)"; [ -n "$CONV" ] && break; sleep 2; done
[ -z "$CONV" ] && { say "no conversation"; exit 3; }

START=$(date +%s); LAST=0
while :; do
  EL=$(( $(date +%s) - START ))
  [ "$EL" -ge "$MAX" ] && { say "TIMEOUT ${EL}s"; break; }
  read -r TURNS BUSY < <(/usr/bin/python3 -c "
import json,sys
d=json.load(open(sys.argv[1])); ms=d.get('messages',[])
done=[m for m in ms if m['role']=='assistant' and (m.get('metrics') or m.get('toolCalls'))]
last=ms[-1] if ms else {}
print(len(done), 1 if (last.get('role')=='assistant' and not last.get('metrics')) else 0)
" "$CONV" 2>/dev/null || echo "0 1")
  if [ "$TURNS" -gt "$LAST" ]; then LAST=$TURNS; say "turn $TURNS at ${EL}s"; shot "02-turn$TURNS"; fi
  N=$(find "$WS" -maxdepth 1 -name '*.html' -size +2k 2>/dev/null | wc -l | tr -d ' ')
  [ "$N" -gt 0 ] && [ "$BUSY" = "0" ] && [ "$EL" -gt 25 ] && { say "file written, idle"; break; }
  sleep 5
done
shot 03-final

/usr/bin/python3 - "$CONV" "$WS" "$MODEL" <<'PY' | tee -a "$OUT/log.txt"
import json, sys, os, glob
conv, ws, model = sys.argv[1:4]
d = json.load(open(conv))
turns = [m for m in d['messages'] if m['role'] == 'assistant']
think = sum(len(m.get('reasoning') or '') for m in turns)
tools = [c['name'] for m in turns for c in (m.get('toolCalls') or [])]
wall = sum((m.get('metrics') or {}).get('totalMs', 0) for m in turns) / 1000
peak = max([(m.get('metrics') or {}).get('promptTokens', 0) for m in turns] or [0])
files = glob.glob(os.path.join(ws, '*.html'))
best = 0
for f in files:
    t = open(f, encoding='utf-8', errors='replace').read()
    best = max(best, len(t))
print('MODEL %s' % model)
print('turns %d  wall %.0fs  think %d chars  peakctx %d' % (len(turns), wall, think, peak))
print('tools %s' % (', '.join(tools) or 'none'))
print('bytes %d' % best)
print('RESULT %s' % ('BUILT' if best > 2500 else 'NOTHING'))
PY
