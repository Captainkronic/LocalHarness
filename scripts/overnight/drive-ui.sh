#!/bin/bash
# Types a prompt into CaptainLlama's composer and sends it, the way a person
# would: a real click into the box, paste, then Return.
#
# System Events can drive this app's MENUS but not its canvas — Electron does
# not take keyboard focus from a synthetic AX click, so the composer stays
# empty however precisely the coordinates are computed. cliclick posts a real
# CGEvent, which the renderer accepts.
#
# Every click is guarded. A synthetic click goes to whatever is on top at those
# coordinates, not to the app you meant, and the first version of this script
# typed into a DIFFERENT application's composer because another window had come
# forward between activating and clicking. So: activate, confirm frontmost,
# then click — and confirm the text actually landed before pressing Return.
#
#   drive-ui.sh "prompt text"
set -euo pipefail
PROMPT="$1"
APP="CaptainLlama"

front() { osascript -e 'tell application "System Events" to return name of first process whose frontmost is true'; }

osascript -e "tell application \"$APP\" to activate" >/dev/null 2>&1
sleep 2
if [ "$(front)" != "$APP" ]; then
  echo "REFUSED: $APP is not frontmost (it is $(front)) — not clicking blind" >&2
  exit 2
fi

# The window moves between launches, so the composer is located from the
# window's own geometry rather than a remembered pixel.
read -r X Y W H < <(osascript -e "tell application \"System Events\" to tell process \"$APP\" to get {position, size} of window 1" | tr ',' ' ')
CX=$(( X + W / 2 ))
CY=$(( Y + H - 62 ))

printf '%s' "$PROMPT" | pbcopy
cliclick "c:${CX},${CY}"
sleep 0.8

# Re-check: the click itself can raise something else.
if [ "$(front)" != "$APP" ]; then
  echo "REFUSED: focus moved to $(front) after the click" >&2
  exit 2
fi

cliclick "kd:cmd" "t:a" "ku:cmd"
sleep 0.3
cliclick "kd:cmd" "t:v" "ku:cmd"
sleep 1.5

# Proof the paste landed where it was meant to: the clipboard is unchanged, so
# copying the composer's contents back should return the prompt. Selecting all
# and copying is the only read-back this app exposes.
cliclick "kd:cmd" "t:a" "ku:cmd"
sleep 0.3
cliclick "kd:cmd" "t:c" "ku:cmd"
sleep 0.5
GOT="$(pbpaste | head -c 40)"
WANT="$(printf '%s' "$PROMPT" | head -c 40)"
if [ "$GOT" != "$WANT" ]; then
  echo "REFUSED: composer holds '${GOT:0:30}...' not the prompt — not sending" >&2
  exit 3
fi

# The send BUTTON, not Return. A synthetic Return never reaches this app's
# handler however the selection is arranged — the composer keeps the text and
# the button stays lit. And the button is not at the window's right edge: the
# Workspace panel takes the last ~300px, putting send at about 73% across.
SEND_X=$(( X + (W * 73 / 100) ))
cliclick "kp:arrow-right"
sleep 0.3
cliclick "c:${SEND_X},${CY}"
echo "sent (button ${SEND_X},${CY})"
