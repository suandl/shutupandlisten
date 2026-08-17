#!/usr/bin/env bash
# gate-a3-release-exclusions.sh — Gate A3 from
# docs/plans/2026-08-02-001-port-transcript-core-onto-post-pr37-main-plan.md
# (Stage 10, "A3 — the direct EXCLUDED_SOURCE_FILE_NAMES check").
#
# THE SETTING HALF of the security gate. Reads the app target's *resolved*
# Release build settings and asserts that all four capture-seam artifacts are
# named in EXCLUDED_SOURCE_FILE_NAMES. Its companion, gate-b5-release-archive.sh,
# reads the built artifact instead. The plan is explicit that these are BOTH
# required, not either: "A3 proved the setting; this proves the artifact."
#
# Why both. B5 reads symbol *absence*, which dead-stripping can also produce —
# so a clean archive does not by itself prove the source was excluded. A3 reads
# the intent directly, and does it in seconds without an archive, so a dropped
# exclusion is caught at the top of the job rather than at the end of it.
#
# Resolved settings are the right thing to read: they reflect what the build will
# actually do after xcconfig layering and any $(inherited) expansion, which a
# grep of project.pbxproj does not.
#
# Runs identically on a developer Mac and the GitHub macOS runner (needs Xcode,
# nothing else). Exits nonzero on any missing exclusion.

# Deliberately NOT `set -e`: an unset setting must reach the explicit message
# below rather than killing the shell on grep's nonzero exit.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"          # ios/
PROJECT="$ROOT/ShutUpAndListen.xcodeproj"
TARGET="ShutUpAndListen"

# All four, by name. A check that greps for one of them reports OK while the
# other three are silently dropped — which is the whole failure this gate exists
# to catch.
#
# NOTE: capture-fixture.json is deliberately NOT asserted here. It is a canned
# listener/analyst response with no credential in it, and it is not on the plan's
# list — but it IS still copied into the Release bundle today. Tracked separately
# (su-a71zn); do not fold it in here without moving the plan's list first.
required='CaptureSeam.swift CaptureURLProtocol.swift CaptureAudioInjector.swift demo-conversation.wav'

excluded=$(xcodebuild -project "$PROJECT" \
                      -target "$TARGET" \
                      -configuration Release \
                      -showBuildSettings 2>/dev/null \
           | grep -E '^[[:space:]]*EXCLUDED_SOURCE_FILE_NAMES[[:space:]]*=')

echo "${excluded:-<EXCLUDED_SOURCE_FILE_NAMES is unset in Release>}"

missing=''
for f in $required; do
  case "$excluded" in
    *"$f"*) ;;
    *)      missing="$missing $f" ;;
  esac
done

if [ -n "$missing" ]; then
  echo "SECURITY: not excluded from the Release build:$missing" >&2
  exit 1
fi
echo 'A3 OK — all four capture artifacts excluded in Release'
