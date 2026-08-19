#!/bin/bash
# Build several games through the real GUI, one after another, and play-test
# each one. The point is not any single game: it is what breaks when the harness
# is asked to do the same job repeatedly with different content.
#
#   stress.sh <name> <prompt>
set -uo pipefail
NAME="$1"; PROMPT="$2"
ROOT=/Users/adam/LocalHarness
WS="/Users/adam/Documents/QWEN 38/GameStation/stress"
OUT="$ROOT/.overnight/stress-$NAME"
mkdir -p "$OUT" "$WS"

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$OUT/log.txt"; }
shot() {
  osascript -e 'tell application "CaptainLlama" to activate' >/dev/null 2>&1
  sleep 1
  screencapture -x -o "$OUT/$1.png" 2>/dev/null
  sips -Z 1250 "$OUT/$1.png" --out "$OUT/$1.s.png" >/dev/null 2>&1
}
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

say "=== $NAME ==="
osascript -e 'tell application "CaptainLlama" to activate' >/dev/null 2>&1; sleep 2
osascript -e 'tell application "System Events" to tell process "CaptainLlama" to click menu item "New Conversation" of menu 1 of menu bar item "File" of menu bar 1' >/dev/null 2>&1
sleep 3
"$ROOT/scripts/overnight/drive-ui.sh" "$PROMPT" >> "$OUT/log.txt" 2>&1 || { say "SEND FAILED"; exit 2; }
sleep 5; shot 01-sent; say "sent"

CONV=""; for _ in $(seq 1 20); do CONV="$(find_conv)"; [ -n "$CONV" ] && break; sleep 2; done
[ -z "$CONV" ] && { say "no conversation"; exit 3; }

START=$(date +%s); LAST=0
while :; do
  EL=$(( $(date +%s) - START ))
  [ "$EL" -ge 900 ] && { say "TIMEOUT ${EL}s"; break; }
  read -r TURNS BUSY < <(/usr/bin/python3 -c "
import json,sys
d=json.load(open(sys.argv[1])); ms=d.get('messages',[])
done=[m for m in ms if m['role']=='assistant' and (m.get('metrics') or m.get('toolCalls'))]
last=ms[-1] if ms else {}
print(len(done), 1 if (last.get('role')=='assistant' and not last.get('metrics')) else 0)
" "$CONV" 2>/dev/null || echo "0 1")
  if [ "$TURNS" -gt "$LAST" ]; then LAST=$TURNS; say "turn $TURNS at ${EL}s"; shot "02-turn$TURNS"; fi
  N=$(find "$WS" -maxdepth 1 -name "*${NAME}*" -size +2k 2>/dev/null | wc -l | tr -d ' ')
  [ "$N" -gt 0 ] && [ "$BUSY" = "0" ] && [ "$EL" -gt 25 ] && { say "file written, idle"; break; }
  sleep 5
done
shot 03-final

F=$(find "$WS" -maxdepth 1 -name "*${NAME}*" -size +2k 2>/dev/null | head -1)
if [ -n "$F" ]; then
  say "built $(basename "$F") $(wc -c < "$F") bytes"
  node "$ROOT/scripts/overnight/play-test.mjs" "$F" 2>&1 | tee -a "$OUT/log.txt" | tail -14
else
  say "NOTHING BUILT"
fi
/usr/bin/python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
for m in d['messages']:
    if m['role']!='assistant': continue
    met=m.get('metrics') or {}
    print('  %5.0fs ctx %-6s think %-6d %s %s' % ((met.get('totalMs') or 0)/1000, met.get('promptTokens') or '?', len(m.get('reasoning') or ''), ','.join(c['name']+('!' if c.get('status')=='error' else '') for c in (m.get('toolCalls') or [])) or '-', ('ERR '+str(m.get('error'))[:70]) if m.get('error') else ''))
" "$CONV" | tee -a "$OUT/log.txt"
