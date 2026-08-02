#!/usr/bin/env bash
# capture-demo.sh — the single source of truth for the iOS visual-capture
# pipeline. Runs identically on a developer Mac and the GitHub macOS runner.
#
#   1. build-for-testing (shared scheme)
#   2. boot iPhone 16 Pro simulator
#   3. per appearance (light, then dark): record video (light only), run the
#      UITest — which drives the REAL pipeline from the bundled fixture .wav
#      in-app (design: in-app audio injection); no host audio device involved
#   4. extract screenshots from the .xcresult with xcparse into build/artifacts
#
# Artifacts are always collected (even on failure) via an EXIT trap — but a
# failing pass still fails the script. A UITest that never reaches the capture
# checkpoints produces no screenshots, and a green job over an empty artifact
# directory is worse than a red one.
set -euo pipefail

# ── config (overridable via env) ──
SCHEME="ShutUpAndListen"
SIM_NAME="${CAPTURE_SIM:-iPhone 16 Pro}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"          # ios/
PROJECT="$ROOT/ShutUpAndListen.xcodeproj"
DERIVED="$ROOT/build/DerivedData"
ARTIFACTS="$ROOT/build/artifacts"
RESULTS="$ROOT/build/results"

rm -rf "$ARTIFACTS" "$RESULTS"
mkdir -p "$ARTIFACTS" "$RESULTS"

log() { printf '\n=== %s ===\n' "$*"; }

VIDEO_PID=""
collect_artifacts() {
  for mode in light dark; do
    local rb="$RESULTS/$mode.xcresult"
    [[ -d "$rb" ]] || continue
    mkdir -p "$ARTIFACTS/$mode"
    if command -v xcparse >/dev/null 2>&1; then
      xcparse screenshots "$rb" "$ARTIFACTS/$mode" 2>/dev/null || true
    fi
  done
}
cleanup() {
  [[ -n "$VIDEO_PID" ]] && kill -INT "$VIDEO_PID" 2>/dev/null || true
  collect_artifacts || true
}
trap cleanup EXIT

# ── 1. build-for-testing ──
# A generic simulator destination — the specific device need not exist yet, and
# building once for the platform lets any booted arm64 sim run the tests.
log "build-for-testing"
xcodebuild build-for-testing \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO

# ── 2. boot the simulator ──
# Resolve (or create) the target device by name. Override with CAPTURE_SIM if
# "$SIM_NAME" is neither present nor a known device type on this machine.
log "boot $SIM_NAME"
UDID="$(xcrun simctl list devices available | grep -m1 "$SIM_NAME (" | grep -oiE '[0-9a-f-]{36}' || true)"
if [[ -z "${UDID:-}" ]]; then
  log "no '$SIM_NAME' sim found — creating one"
  UDID="$(xcrun simctl create "$SIM_NAME" "$SIM_NAME")"
fi
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b

# Pre-grant privacy so the app's permission requests return granted without a
# blocking TCC dialog — otherwise the session never goes live and the running
# checkpoints (transcript/hint/reply) never render on a fresh CI simulator.
BUNDLE_ID="${CAPTURE_BUNDLE_ID:-sh.shutupandlisten.ios}"
xcrun simctl privacy "$UDID" grant all "$BUNDLE_ID" >/dev/null 2>&1 || true

FAILED_PASSES=""
run_pass() {                      # $1 = light|dark
  local mode="$1"
  local rb="$RESULTS/$mode.xcresult"
  local status=0
  log "capture pass: $mode"
  # The test run can leave the base device shut down; re-boot so every pass
  # (and the appearance toggle + video recording below) has a live device.
  xcrun simctl boot "$UDID" 2>/dev/null || true
  xcrun simctl bootstatus "$UDID" -b
  xcrun simctl ui "$UDID" appearance "$mode"

  if [[ "$mode" == "light" ]]; then
    xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$ARTIFACTS/demo.mov" &
    VIDEO_PID=$!
  fi

  # Run the UITest. It drives the pipeline from the bundled fixture in-app, so
  # there is nothing to feed from the host and no pre-feed timing to align.
  # -parallel-testing-enabled NO keeps the test on the booted base device
  # instead of a throwaway clone — so recordVideo above actually captures the
  # session, not an idle base simulator.
  #
  # The status is REMEMBERED, not swallowed: this pass must not abort the run
  # (the other appearance still deserves a try, and the video/artifacts still
  # need collecting), but it must still fail the job at the end.
  xcodebuild test-without-building \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath "$DERIVED" \
    -resultBundlePath "$rb" \
    -only-testing:ShutUpAndListenUITests/CaptureUITests/testCaptureSession \
    -parallel-testing-enabled NO \
    CODE_SIGNING_ALLOWED=NO || status=$?

  if [[ "$mode" == "light" && -n "$VIDEO_PID" ]]; then
    kill -INT "$VIDEO_PID" 2>/dev/null || true
    wait "$VIDEO_PID" 2>/dev/null || true
    VIDEO_PID=""
  fi

  if [[ "$status" -ne 0 ]]; then
    log "capture pass '$mode' FAILED (exit $status)"
    FAILED_PASSES="${FAILED_PASSES:+$FAILED_PASSES }$mode"
  fi
}

run_pass light
run_pass dark

# Artifact collection runs from the EXIT trap, so it happens on the way out of
# either branch below — a failing run still uploads whatever it managed to
# capture, which is what the workflow's `if: always()` upload expects.
if [[ -n "$FAILED_PASSES" ]]; then
  log "FAILED passes: $FAILED_PASSES — artifacts (if any) in $ARTIFACTS"
  exit 1
fi

log "done — artifacts in $ARTIFACTS"
