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
# handler however the selection is arranged.
#
# Its X is not a fixed fraction of the window. The Workspace panel is resizable,
# and a run that assumed 73% clicked into empty space beside the button: the
# prompt sat in the composer, unsent, and the script reported success. So try
# candidate positions from the panel edge inward and CONFIRM the composer
# emptied — an unsent prompt must be a failure, not a silent no-op.
CY=$(( Y + H - 62 ))
sent=""
# NEVER click the same spot twice. Send and Stop are the SAME control: it turns
# into Stop the instant the turn starts. A "click twice in case the first was
# swallowed" pass sent the prompt and then aborted it 1s later, and the turn
# died as "the model returned an empty reply (finish reason: aborted)".
#
# The first click after activation IS swallowed focusing the window, so absorb
# that with a harmless click on the transcript first, then click send once.
#
# Step finely: the button is ~26pt wide, so 5% strides in a 1440pt window jump
# 72pt and straddle it. A first pass missed at 60% and 65% with it at 63.3%.
cliclick "c:$(( X + W / 2 )),$(( Y + H / 3 ))"
sleep 0.5
# Range widened after a miss at 58.3%: the send button's position depends on
# the Workspace panel's width, which the user resizes, so it wanders further
# than a tight band around one remembered value.
for pct in 63 64 62 65 61 66 60 67 59 68 58 69 57 70; do
  SEND_X=$(( X + (W * pct / 100) ))
  cliclick "c:${SEND_X},${CY}"
  sleep 2
  # Read the composer back. Empty means it went.
  cliclick "c:$(( X + W / 3 )),${CY}"
  sleep 0.3
  # Clear the clipboard FIRST. Copying an empty selection is a no-op that
  # leaves the previous contents in place — and the previous contents are the
  # prompt, so a successful send would read back as a failed one.
  printf 'SENTINEL' | pbcopy
  cliclick "kd:cmd" "t:a" "ku:cmd"
  sleep 0.2
  cliclick "kd:cmd" "t:c" "ku:cmd"
  sleep 0.4
  LEFT="$(pbpaste)"
  [ "$LEFT" = "SENTINEL" ] && LEFT=""
  if [ "${#LEFT}" -lt 10 ]; then
    sent="$pct"
    break
  fi
done

if [ -z "$sent" ]; then
  echo "REFUSED: typed the prompt but could not find the send button — nothing was sent" >&2
  exit 4
fi
echo "sent (button at ${pct}% of window width)"
