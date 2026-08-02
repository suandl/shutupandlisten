#!/usr/bin/env bash
# Regenerate ios/App/Resources/demo-conversation.wav from macOS `say`. Run on a
# Mac and commit the resulting .wav. 16 kHz mono LEI16 is what SFSpeech wants;
# the script matches the seed transcript in App/Resources/capture-fixture.json.
#
# The [[slnc 600]] pauses between sentences are load-bearing: each inter-sentence
# gap must exceed the AudioPipeline VAD's 380 ms hangover so the in-app injector
# (design: in-app audio injection) produces a real speech-end → turn-end at each
# pause, which is what lets the gate escalate and a listener reply land.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"          # ios/
OUT="$DIR/App/Resources/demo-conversation.wav"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$DIR/App/Resources"

say -v Samantha -r 172 -o "$TMP/line.aiff" \
"So I've been thinking about why our onboarding drops off. [[slnc 600]] \
I think the issue is we ask for too much before showing any value. [[slnc 600]] \
People sign up, and then immediately hit a wall of configuration. [[slnc 600]] \
What if we flipped it — let them see one real result first, then ask for the setup?"

afconvert "$TMP/line.aiff" "$OUT" -d LEI16@16000 -f WAVE -c 1
echo "wrote $OUT"
