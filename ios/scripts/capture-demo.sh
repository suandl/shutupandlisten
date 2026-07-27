#!/usr/bin/env bash
# capture-demo.sh — the single source of truth for the iOS visual-capture
# pipeline. Runs identically on a developer Mac and the GitHub macOS runner.
#
#   1. build-for-testing (shared scheme)
#   2. boot iPhone 16 Pro simulator
#   3. host default input = BlackHole (best effort)
#   4. per appearance (light, then dark): record video (light only), run the
#      UITest, and feed fixtures/demo-conversation.wav into the host mic while
#      it dwells
#   5. extract screenshots from the .xcresult with xcparse into build/artifacts
#
# Artifacts are always collected (even on failure) via an EXIT trap. Only a
# genuine build failure fails the job.
set -euo pipefail

# ── config (overridable via env) ──
SCHEME="ShutUpAndListen"
SIM_NAME="${CAPTURE_SIM:-iPhone 16 Pro}"
BLACKHOLE_DEVICE="${CAPTURE_AUDIO_DEVICE:-BlackHole 2ch}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"          # ios/
PROJECT="$ROOT/ShutUpAndListen.xcodeproj"
FIXTURE_WAV="$ROOT/fixtures/demo-conversation.wav"
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

# ── 3. host audio input = BlackHole (best effort) ──
if command -v SwitchAudioSource >/dev/null 2>&1; then
  log "set host input = $BLACKHOLE_DEVICE"
  SwitchAudioSource -t input -s "$BLACKHOLE_DEVICE" || true
fi

run_pass() {                      # $1 = light|dark
  local mode="$1"
  local rb="$RESULTS/$mode.xcresult"
  log "capture pass: $mode"
  xcrun simctl ui "$UDID" appearance "$mode"

  if [[ "$mode" == "light" ]]; then
    xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$ARTIFACTS/demo.mov" &
    VIDEO_PID=$!
  fi

  # Run the UITest in the background so we can feed audio while it dwells.
  ( xcodebuild test-without-building \
      -project "$PROJECT" \
      -scheme "$SCHEME" \
      -destination "platform=iOS Simulator,id=$UDID" \
      -derivedDataPath "$DERIVED" \
      -resultBundlePath "$rb" \
      -only-testing:ShutUpAndListenUITests/CaptureUITests/testCaptureSession \
      CODE_SIGNING_ALLOWED=NO ) &
  local test_pid=$!

  # Give the app time to launch + tap Start, then feed the fixture audio.
  sleep 6
  if [[ -f "$FIXTURE_WAV" ]] && command -v afplay >/dev/null 2>&1; then
    afplay "$FIXTURE_WAV" || true
  fi
  wait "$test_pid" || true

  if [[ "$mode" == "light" && -n "$VIDEO_PID" ]]; then
    kill -INT "$VIDEO_PID" 2>/dev/null || true
    wait "$VIDEO_PID" 2>/dev/null || true
    VIDEO_PID=""
  fi
}

run_pass light
run_pass dark

log "done — artifacts in $ARTIFACTS"
