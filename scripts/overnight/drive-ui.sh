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
# The prompt goes through pbcopy, and pbcopy encodes according to the locale.
# Under the default C locale an em-dash arrives in the composer as mojibake —
# observed as "play it ,Ai press" in a real run, which is what the model then
# reads. Force UTF-8 so what is typed is what was meant.
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
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

# Retry the whole focus-click-paste-verify cycle.
#
# Focus is contested on a machine where something else is also being driven, and
# a Cmd+V whose modifier does not register types a literal "v" into the
# composer. Both were observed. Each attempt clears whatever is there first, so
# a failed try cannot leave debris that the next one appends to.
ATTEMPT=0
while :; do
  ATTEMPT=$(( ATTEMPT + 1 ))
  if [ "$ATTEMPT" -gt 4 ]; then
    echo "REFUSED: could not get the prompt into the composer after 4 tries" >&2
    exit 3
  fi

  osascript -e "tell application \"$APP\" to activate" >/dev/null 2>&1
  sleep 1.5
  [ "$(front)" != "$APP" ] && continue

  cliclick "c:${CX},${CY}"
  sleep 0.6
  [ "$(front)" != "$APP" ] && continue

  # Clear, then paste.
  cliclick "kd:cmd" "t:a" "ku:cmd"
  sleep 0.25
  cliclick "kp:delete"
  sleep 0.25
  cliclick "kd:cmd" "t:v" "ku:cmd"
  sleep 1.2

  # Read it back: select all, copy, compare. The clipboard still holds the
  # prompt, so a match means the composer really has it.
  cliclick "kd:cmd" "t:a" "ku:cmd"
  sleep 0.25
  cliclick "kd:cmd" "t:c" "ku:cmd"
  sleep 0.5
  GOT="$(pbpaste | head -c 40)"
  WANT="$(printf '%s' "$PROMPT" | head -c 40)"
  [ "$GOT" = "$WANT" ] && break

  echo "  attempt $ATTEMPT: composer held '${GOT:0:24}' — retrying" >&2
  printf '%s' "$PROMPT" | pbcopy
  sleep 1
done

# The send BUTTON, not Return. A synthetic Return never reaches this app's
# handler however the selection is arranged. The button is not at the window's
# right edge either: the Workspace panel takes the last ~300px, putting send at
# about 73% across. Recomputed here because the retry loop above may have run
# after the window moved.
SEND_X=$(( X + (W * 73 / 100) ))
cliclick "kp:arrow-right"
sleep 0.3
cliclick "c:${SEND_X},${CY}"
echo "sent (button ${SEND_X},${CY})"
