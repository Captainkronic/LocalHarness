#!/bin/bash
#
# CaptainLlama installer.
#
# Short on purpose. This script asks macOS to stop treating the app as
# quarantined, which is a thing you should be able to read in full before you
# run it. Everything it does is below; there is no second stage.
#
# Why it is needed: the app is ad-hoc signed rather than notarised, so
# Gatekeeper refuses to open it and says it is "damaged", which it is not. The
# alternative is a $99/year Apple Developer account.
#
set -euo pipefail

APP="CaptainLlama.app"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/$APP"
DEST="/Applications/$APP"

printf '\n  CaptainLlama\n  ============\n\n'

if [ ! -d "$SRC" ]; then
  printf '  Cannot find %s next to this script.\n' "$APP"
  printf '  Run this from the mounted disk image, not from a copy.\n\n'
  exit 1
fi

if [ -d "$DEST" ]; then
  printf '  Replacing the existing copy in /Applications.\n'
  # Settings, conversations and installed servers live in Application Support,
  # so replacing the app keeps every one of them.
  rm -rf "$DEST"
fi

printf '  Copying to /Applications ...\n'
cp -R "$SRC" "$DEST"

printf '  Clearing the quarantine flag ...\n'
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

printf '  Starting CaptainLlama ...\n\n'
open "$DEST"

printf '  Done. The app will ask where your inference server is.\n'
printf '  Nothing else is installed until you choose it there.\n\n'
