#!/usr/bin/env bash
# gate-b5-release-archive.sh — Gates B4 + B5 from
# docs/plans/2026-08-02-001-port-transcript-core-onto-post-pr37-main-plan.md
# (Stage 12: "B4 — the port builds for shipping", "B5 — the archive check,
# stated as a command with a log").
#
# THE ARTIFACT HALF of the security gate. B4 writes a Release archive; B5 reads
# it and exits nonzero if the CI capture seam is in there. "Inspect the archive"
# is not a gate: it is an instruction to look, it produces no artifact, and it is
# the last thing anyone does at the end of a long day.
#
# What it is proving: the capture seam can overwrite the listener's API key in
# memory (CaptureSeam.fakeAPIKey → CaptureURLProtocol) and bypass onboarding. It
# is kept out of Release by TWO mechanisms — `#if DEBUG` around every seam file,
# and EXCLUDED_SOURCE_FILE_NAMES on the app target's Release config. This is the
# proof that su-uzy9.1's fix held in the shipped artifact. Its companion,
# gate-a3-release-exclusions.sh, proves the setting. BOTH are required, not
# either.
#
# Read the symbol half honestly: ABSENCE IS NECESSARY, NOT SUFFICIENT. Dead
# stripping can remove a symbol that was compiled in, so a clean nm/strings does
# not by itself prove the source was excluded — that is A3's job. The fixture
# check below is the half dead-stripping cannot fake: a resource is either copied
# into the bundle or it is not.
#
# Runs identically on a developer Mac and the GitHub macOS runner. No signing
# identity needed — the archive is built unsigned on purpose (see below).

# pipefail is load-bearing: the check body runs through `tee`, and without it the
# pipeline would report tee's exit, not the check's. Not -e — every finding must
# be printed before exit.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"          # ios/
PROJECT="$ROOT/ShutUpAndListen.xcodeproj"
SCHEME="ShutUpAndListen"
DERIVED="$ROOT/build/DerivedData"
ARCHIVE="${B5_ARCHIVE:-$ROOT/build/gates/sual.xcarchive}"
LOG="${B5_LOG:-$ROOT/build/gates/b5-archive-check.log}"

log() { printf '\n=== %s ===\n' "$*"; }

rm -rf "$ARCHIVE"
mkdir -p "$(dirname "$ARCHIVE")" "$(dirname "$LOG")"

# ── B4: the Release archive ──────────────────────────────────────────────────
# UNSIGNED, deliberately. Signing needs a team credential this job does not have
# and must not have, and B5 reads the bundle's contents — the fixture resource
# and the binary's symbols — which a signature changes not at all. So an unsigned
# archive proves exactly what the gate is here to prove, with no secret in CI.
#
# The project's app target is set to Automatic signing with a real team, so every
# signing input is overridden on the command line rather than edited in the
# project: CODE_SIGN_STYLE=Manual keeps automatic signing from going looking for
# an account, and the empty identity/team/profile/entitlements settings leave
# nothing for the (skipped) sign step to resolve.
log "B4 — archive Release"
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED" \
  -archivePath "$ARCHIVE" \
  archive \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGN_ENTITLEMENTS="" \
  DEVELOPMENT_TEAM="" \
  PROVISIONING_PROFILE_SPECIFIER=""
xc=$?
[ "$xc" -eq 0 ] || { echo "B4 FAILED: xcodebuild archive exited $xc" >&2; exit 1; }

# ── B5: read what B4 wrote ───────────────────────────────────────────────────
log "B5 — inspect the archive"

check() {
  APP=$(find "$ARCHIVE/Products/Applications" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null)
  [ -n "${APP:-}" ] || { echo "B5 FAILED: no .app under $ARCHIVE/Products/Applications" >&2; return 1; }

  EXE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist" 2>/dev/null)
  BIN="$APP/${EXE:-}"
  [ -f "$BIN" ] || { echo "B5 FAILED: no executable inside $APP" >&2; return 1; }
  echo "B5 inspecting: $BIN"

  fail=0

  # 1. The fixture must not ship — any name match, anywhere in the bundle.
  #    This is the check dead-stripping cannot fake: a resource is either
  #    copied into the bundle or it is not.
  hits=$(find "$APP" -name 'demo-conversation.wav')
  if [ -n "$hits" ]; then
    echo "SECURITY: demo-conversation.wav present in the archived bundle:" >&2
    echo "$hits" >&2
    fail=1
  fi

  # 2. No capture-seam type names in the binary. Read the symbol table AND the
  #    raw strings: a Release binary is stripped of local symbols, but Swift
  #    type names survive in metadata/reflection sections, so `strings` sees
  #    what `nm` no longer does. Either hit is a failure.
  #
  #    Dump ONCE to a file and grep the FILE. Never `grep -q` a live producer
  #    here: `grep -q` exits at its first match and closes the pipe, the
  #    `nm`/`strings` producer then dies of SIGPIPE (141), and `pipefail` —
  #    load-bearing for the `tee` below — makes the whole pipeline nonzero. The
  #    `if` would take the *else* branch on a real hit, leaving `fail` unset, and
  #    B5 would print OK with the seam shipped. That is a fail-OPEN on precisely
  #    the condition this gate exists to catch. A file has no producer to kill,
  #    so the early exit is harmless. (Buffering into a shell variable does not
  #    fix it: `printf '%s' "$SYMS" | grep -q` re-creates the same pipe and the
  #    builtin takes the same EPIPE.)
  SYMS=$(mktemp "${TMPDIR:-/tmp}/sual-b5-syms.XXXXXX") \
    || { echo 'B5 FAILED: could not create the symbol-dump temp file' >&2; return 1; }
  { nm -a "$BIN" 2>/dev/null; strings -a "$BIN" 2>/dev/null; } > "$SYMS"

  # Both tools silent means the binary was not read at all — an unreadable
  # binary is indistinguishable from a clean one by grep alone, so fail closed
  # rather than reporting "no seam symbols found".
  if [ ! -s "$SYMS" ]; then
    echo "B5 FAILED: nm and strings both produced no output for $BIN" >&2
    rm -f "$SYMS"
    return 1
  fi

  for sym in CaptureSeam CaptureURLProtocol CaptureAudioInjector; do
    if grep -q "$sym" "$SYMS"; then
      echo "SECURITY: '$sym' found in the archived binary" >&2
      fail=1
    fi
  done
  rm -f "$SYMS"

  [ "$fail" -eq 0 ] || { echo 'B5 FAILED: archive is not clean' >&2; return 1; }
  echo 'B5 OK — no capture fixture, no capture-seam symbols in the Release archive'
}

check 2>&1 | tee "$LOG"
