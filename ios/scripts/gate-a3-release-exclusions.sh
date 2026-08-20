#!/usr/bin/env bash
# gate-a3-release-exclusions.sh — Gate A3 from
# docs/plans/2026-08-02-001-port-transcript-core-onto-post-pr37-main-plan.md
# (Stage 10, "A3 — the direct EXCLUDED_SOURCE_FILE_NAMES check").
#
# THE SETTING HALF of the security gate. Reads the app target's *resolved*
# Release build settings and asserts that all five capture-seam artifacts are
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

# All five, by name. A check that greps for one of them reports OK while the
# other four are silently dropped — which is the whole failure this gate exists
# to catch.
#
# capture-fixture.json joined this list in su-a71zn, and the plan's Gate A3 list
# moved in the same commit. It is the mildest of the five: no credential in it,
# and its only reader — CaptureSeam.loadFixture() — is itself `#if DEBUG` and
# excluded, so a Release binary could not read the file even back when it did
# ship. It is asserted anyway, because the design intent stated everywhere else
# is that the WHOLE capture seam is compiled out of Release, and a fixture left
# sitting in the bundle is that claim being false in the one place a reviewer
# can actually check it.
required='CaptureSeam.swift CaptureURLProtocol.swift CaptureAudioInjector.swift demo-conversation.wav capture-fixture.json'

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
echo 'A3 OK — all five capture artifacts excluded in Release'
