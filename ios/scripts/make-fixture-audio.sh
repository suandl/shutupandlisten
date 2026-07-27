#!/usr/bin/env bash
# Regenerate ios/fixtures/demo-conversation.wav from macOS `say`. Run on a Mac
# and commit the resulting .wav. 16 kHz mono LEI16 is what SFSpeech wants; the
# script matches the seed transcript in App/Resources/capture-fixture.json.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"          # ios/
OUT="$DIR/fixtures/demo-conversation.wav"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$DIR/fixtures"

say -v Samantha -r 172 -o "$TMP/line.aiff" \
"So I've been thinking about why our onboarding drops off. \
I think the issue is we ask for too much before showing any value. \
People sign up, and then immediately hit a wall of configuration. \
What if we flipped it — let them see one real result first, then ask for the setup?"

afconvert "$TMP/line.aiff" "$OUT" -d LEI16@16000 -f WAVE -c 1
echo "wrote $OUT"
