#!/bin/bash
# One attempt: fresh conversation, send a prompt through the real UI, watch it
# work, screenshot as it goes, and report whether a playable file landed.
#
#   run-attempt.sh <label> <prompt-file> <workspace> <max-seconds>
set -uo pipefail
LABEL="$1"; PROMPT_FILE="$2"; WS="$3"; MAX="${4:-1800}"
ROOT=/Users/adam/LocalHarness
SHOTS="$ROOT/.overnight/$LABEL"
mkdir -p "$SHOTS" "$WS"

shot() {  # shot <name>
  screencapture -x -o "$SHOTS/$1.png" 2>/dev/null
  sips -Z 1250 "$SHOTS/$1.png" --out "$SHOTS/$1.s.png" >/dev/null 2>&1
}

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$SHOTS/log.txt"; }

say "=== $LABEL ==="
say "workspace $WS"

# Fresh conversation so nothing earlier is in context.
osascript -e 'tell application "CaptainLlama" to activate' >/dev/null 2>&1
sleep 2
osascript -e 'tell application "System Events" to tell process "CaptainLlama" to click menu item "New Conversation" of menu 1 of menu bar item "File" of menu bar 1' >/dev/null 2>&1
sleep 3

# Finding the live conversation is done in python, not shell: the store lives
# under "Application Support", and the space in that path word-splits every
# unquoted $(ls) — which is how the first version of this failed to find a
# conversation it had just created.
find_conv() {
  /usr/bin/python3 - <<'PY'
import glob, json, os
d = os.path.expanduser('~/Library/Application Support/localharness/conversations')
best = None
for f in sorted(glob.glob(os.path.join(d, '*.json')), key=os.path.getmtime, reverse=True)[:6]:
    try:
        c = json.load(open(f))
    except Exception:
        continue
    if c.get('workflowId') != 'code':
        continue
    if any(m.get('role') == 'user' for m in c.get('messages', [])):
        best = f
        break
print(best or '')
PY
}

"$ROOT/scripts/overnight/drive-ui.sh" "$(cat "$PROMPT_FILE")" >> "$SHOTS/log.txt" 2>&1 || { say "SEND FAILED"; exit 2; }
sleep 6
shot 01-sent
say "sent"

CONV=""
for _ in $(seq 1 20); do
  CONV="$(find_conv)"
  [ -n "$CONV" ] && break
  sleep 2
done
[ -z "$CONV" ] && { say "no conversation found"; exit 3; }
say "watching $(basename "$CONV" .json | cut -c1-8)"

START=$(date +%s)
LAST_TURNS=0
while :; do
  NOW=$(date +%s); EL=$(( NOW - START ))
  [ "$EL" -ge "$MAX" ] && { say "TIMEOUT after ${EL}s"; break; }

  read -r TURNS BUSY < <(python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
ms=d.get('messages',[])
done=[m for m in ms if m['role']=='assistant' and (m.get('metrics') or m.get('toolCalls'))]
last=ms[-1] if ms else {}
busy=1 if (last.get('role')=='assistant' and not last.get('metrics')) else 0
print(len(done), busy)
" "$CONV" 2>/dev/null || echo "0 1")

  if [ "$TURNS" -gt "$LAST_TURNS" ]; then
    LAST_TURNS=$TURNS
    say "turn $TURNS at ${EL}s"
    shot "02-turn$TURNS"
  fi

  # Done when a game file exists and the model has stopped working.
  FILES=$(find "$WS" -maxdepth 1 -name '*.html' -size +2k 2>/dev/null | wc -l | tr -d ' ')
  if [ "$FILES" -gt 0 ] && [ "$BUSY" = "0" ] && [ "$EL" -gt 30 ]; then
    say "FILE WRITTEN, model idle"
    break
  fi
  sleep 5
done

shot 03-final
say "--- result ---"
find "$WS" -maxdepth 1 -name '*.html' -exec ls -la {} \; 2>/dev/null | tee -a "$SHOTS/log.txt"
python3 - "$CONV" "$WS" <<'PY' | tee -a "$SHOTS/log.txt"
import json,sys,os,glob,re
conv,ws=sys.argv[1],sys.argv[2]
d=json.load(open(conv))
turns=[m for m in d['messages'] if m['role']=='assistant']
print('turns: %d' % len(turns))
for i,m in enumerate(turns,1):
    met=m.get('metrics') or {}
    tools=','.join(c['name'] for c in (m.get('toolCalls') or [])) or '-'
    print('  %2d %6.0fs ctx %-6s think %-6d wrote %-5d %s %s' % (
        i,(met.get('totalMs') or 0)/1000, met.get('promptTokens') or '?',
        len(m.get('reasoning') or ''), len(m.get('content') or ''), tools,
        ('ERR:'+str(m.get('error'))[:60]) if m.get('error') else ''))
best=None
for f in glob.glob(os.path.join(ws,'*.html')):
    t=open(f,encoding='utf-8',errors='replace').read()
    score=sum(1 for k in ('canvas','requestAnimationFrame','keydown','score') if k in t)
    print('FILE %s %d bytes markers=%d/4' % (os.path.basename(f), len(t), score))
    if score>=3 and len(t)>2000: best=f
print('VERDICT', 'PASS' if best else 'FAIL')
PY
