#!/usr/bin/env bash
# gate-b1-app-tests.sh — Gate B1 from
# docs/plans/2026-08-02-001-port-transcript-core-onto-post-pr37-main-plan.md
# (Stage 12, "B1 — the app-test run, stated as a command with a proof").
#
# THE DATA-SAFETY GATE (§5.3). Runs the app-hosted MigrationTests + WriterTests
# on a simulator and proves they ACTUALLY RAN. `⌘U` is not a gate: it is green
# when a test target exists but contains nothing runnable, and it leaves no
# artifact to check. So: name the tests, gate on the exit status, and assert the
# result bundle.
#
# Four things make this a gate rather than a ritual:
#
#   1. `-only-testing` FAILS THE BUILD OUTRIGHT when an identifier is not in the
#      target. At method granularity that covers both the §0.2 failure mode (no
#      test class wired) and the §5.5 one (the class is wired but a required case
#      was never written) — so "nonzero count per class" is enforced by
#      xcodebuild itself rather than by name-matching in jq.
#   2. The explicit $xc gate. Without it, jq is reached however xcodebuild
#      exited, and a red suite with a well-populated result bundle reports green.
#   3. The jq -e assertion independently requires that cases ran and that none
#      carry result == "Failed", so a bundle that is green-but-empty also fails.
#   4. The result bundle is a durable artifact someone else can re-check.
#
# Runs identically on a developer Mac and the GitHub macOS runner.

# `-u -o pipefail` but deliberately NOT `-e`: the xcodebuild status is captured
# and reported explicitly below, which `-e` would pre-empt with a bare exit.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"          # ios/
PROJECT="$ROOT/ShutUpAndListen.xcodeproj"
SCHEME="ShutUpAndListen"
DERIVED="$ROOT/build/DerivedData"
RB="${B1_RESULT_BUNDLE:-$ROOT/build/gates/b1-app-tests.xcresult}"

# ── the count floor ──────────────────────────────────────────────────────────
# Eight MigrationTests selectors plus WriterTests' six methods. THIS NUMBER AND
# THE SELECTOR LIST BELOW MOVE TOGETHER — that is §7's own rule, and it is why
# the floor is a literal here rather than an env knob: a gate whose bar can be
# lowered from the outside is not a bar. Raise it when a selector is added, and
# raise it with WriterTests if that class grows.
MIN_CASES=14

# ── simulator ────────────────────────────────────────────────────────────────
# The plan writes this destination as
# `platform=iOS Simulator,name=iPhone 16,OS=26.0`. That is stale for the runner
# image this gate targets: macos-26 ships no iPhone 16 family device except the
# 16e, so the name lookup misses and the run dies at destination resolution
# before a single test executes. Resolve by name → UDID exactly the way
# capture-demo.sh does — the one path in this repo with a green macos-26 run
# behind it (run 31768705979, "iPhone 17 Pro" resolved and booted). Override
# with CAPTURE_SIM on a Mac carrying a different set of simulators.
SIM_NAME="${CAPTURE_SIM:-iPhone 17 Pro}"

rm -rf "$RB"
mkdir -p "$(dirname "$RB")"

log() { printf '\n=== %s ===\n' "$*"; }

command -v jq >/dev/null 2>&1 \
  || { echo 'B1 FAILED: jq is required for the result-bundle assertion' >&2; exit 1; }

log "resolve $SIM_NAME"
UDID="$(xcrun simctl list devices available | grep -m1 "$SIM_NAME (" | grep -oiE '[0-9a-f-]{36}' || true)"
if [ -z "${UDID:-}" ]; then
  log "no '$SIM_NAME' sim found — creating one"
  UDID="$(xcrun simctl create "$SIM_NAME" "$SIM_NAME")" \
    || { echo "B1 FAILED: could not resolve or create a '$SIM_NAME' simulator" >&2; exit 1; }
fi

# Boot explicitly and wait. xcodebuild would boot it too, but doing it here
# means a device that cannot boot fails as "the simulator did not come up"
# rather than as an opaque mid-test error.
log "boot $UDID"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b \
  || { echo "B1 FAILED: simulator $UDID never reached booted state" >&2; exit 1; }

# These are unit tests, not a live session — but the host app still launches,
# and a blocking TCC dialog on a fresh CI simulator would hang the run rather
# than fail it. Pre-granting costs nothing and is what capture-demo.sh does.
xcrun simctl privacy "$UDID" grant all "${CAPTURE_BUNDLE_ID:-sh.shutupandlisten.ios}" >/dev/null 2>&1 || true

# ── the run ──────────────────────────────────────────────────────────────────
# Eight MigrationTests selectors, not five. The first five are §5.5 items 1–5,
# the new cases. The last three are the class's EXISTING tests, which §5.5 item 6
# keeps as-is — and a kept test that no gate names is a test the port can delete
# without anything going red. Naming them here gives them the same
# fail-by-name protection the new ones get.
log "xcodebuild test"
xcodebuild test \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath "$DERIVED" \
  -resultBundlePath "$RB" \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testV1FixtureIsPR37Shape \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testCostUSDSurvivesV1ToV2 \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testMigrationCarriesPR37Timings \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testMaterializedRowsAgreeWithLazyFallback \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testBaseShapeYieldsZeroedRangesAndNoTimings \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testMigrationMaterializesOrderedSegmentRows \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testMigratedRecordDerivedViewsComeFromSegments \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testLazyMaterializerDecodesLegacyBlobOnRead \
  -only-testing:ShutUpAndListenAppTests/WriterTests \
  -parallel-testing-enabled NO \
  CODE_SIGNING_ALLOWED=NO
xc=$?
[ "$xc" -eq 0 ] || { echo "B1 FAILED: xcodebuild test exited $xc" >&2; exit 1; }

# ── the second mechanism ─────────────────────────────────────────────────────
# The bundle must show cases, and none of them failed.
#
# No `--legacy` fallback here on purpose. The workflow that runs this asserts
# Xcode 26.x before reaching this step, and `get test-results tests` is the
# supported form on every Xcode ≥ 16 — so an unreadable bundle means something is
# wrong, not that the toolchain is old. Failing closed on it is the point: a
# fallback chain is exactly where a "could not read the bundle" turns into a
# green run. (On an older toolchain, read ActionTestMetadata entries out of
# `xcrun xcresulttool get --legacy --format json --path "$RB"` instead — the same
# two properties, count and status.)
log "result-bundle assertion"
xcrun xcresulttool get test-results tests --path "$RB" --format json \
  | jq -e --argjson floor "$MIN_CASES" '
      [.. | objects | select((.nodeType? // "") == "Test Case")]        as $cases
      | ($cases | map(select((.result? // "") == "Failed")) | length)   as $failed
      | if ($cases | length) >= $floor and $failed == 0 then true
        else error("B1: \($cases | length) cases ran (expected >= \($floor)), \($failed) failed")
        end' > /dev/null \
  || { echo 'B1 FAILED: result-bundle assertion' >&2; exit 1; }

echo "B1 OK — result bundle at $RB"
