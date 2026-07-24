#!/usr/bin/env bash
# post-create-project.sh — project hook invoked by the agent-env base image's
# post-create.sh (its Step 13). Runs on every container create/rebuild, AFTER
# the firewall is initialized, so swift.org (allowlisted in allowed-domains.txt)
# is already reachable here.
#
# Purpose: guarantee a Swift toolchain is present so the platform-agnostic
# ios/ShutUpAndListenKit tests (spec golden vectors + ClaudeClient/TurnEngine)
# run headlessly, without a Mac. The kit has zero external SwiftPM deps, so
# `swift test` is fully offline once this has installed the toolchain.
#
# Idempotent and update-aware: re-installs only when the installed toolchain
# version differs from SWIFT_VERSION. The 1 GB tarball is cached in the
# workspace (survives rebuilds; $HOME does not), so a rebuild re-extracts
# without re-downloading. Non-fatal: a swift.org hiccup warns, never breaks
# container creation.
set -uo pipefail

SWIFT_VERSION="${SWIFT_VERSION:-6.3.3}"
PLATFORM="${SWIFT_PLATFORM:-debian12-aarch64}"   # runs on Debian 13/trixie via glibc forward-compat
INSTALL_DIR="${SWIFT_INSTALL_DIR:-$HOME/swift}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$REPO_ROOT/.devcontainer/.swift-cache"
ALLOWLIST="$REPO_ROOT/.devcontainer/allowed-domains.txt"
SWIFT_BIN="$INSTALL_DIR/usr/bin"
TARBALL="$CACHE_DIR/swift-${SWIFT_VERSION}-${PLATFORM}.tar.gz"
WANT="swift-${SWIFT_VERSION}-RELEASE"

log() { echo "  [swift] $*"; }

ensure_path() {
  local line="export PATH=\"$SWIFT_BIN:\$PATH\""
  local rc
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    [ -f "$rc" ] || touch "$rc"
    grep -qF "$SWIFT_BIN" "$rc" 2>/dev/null || printf '\n# Swift toolchain (post-create-project.sh)\n%s\n' "$line" >> "$rc"
  done
}

# Already the desired version? Just fix PATH and leave.
if [ -x "$SWIFT_BIN/swift" ] && "$SWIFT_BIN/swift" --version 2>/dev/null | grep -q "$WANT"; then
  log "already at ${WANT}"
  ensure_path
  exit 0
fi

# Belt-and-suspenders: make sure the download domains are allowlisted. They are
# committed already; only re-apply the firewall if we had to add one.
added=false
for d in swift.org www.swift.org download.swift.org; do
  grep -qxF "$d" "$ALLOWLIST" 2>/dev/null || { echo "$d" >> "$ALLOWLIST"; added=true; }
done
if [ "$added" = true ] && sudo -n -l 2>/dev/null | grep -q init-firewall.sh; then
  log "re-applying firewall for swift.org domains"
  sudo /usr/local/bin/init-firewall.sh >/dev/null 2>&1 || true
fi

# Fetch (cached) then extract.
mkdir -p "$CACHE_DIR"
if [ ! -s "$TARBALL" ]; then
  url="https://download.swift.org/swift-${SWIFT_VERSION}-release/${PLATFORM}/${WANT}/${WANT}-${PLATFORM}.tar.gz"
  log "downloading ${WANT} (${PLATFORM})…"
  if ! curl -fSL --retry 3 -o "$TARBALL.partial" "$url"; then
    log "WARN: download failed — skipping Swift install (run .devcontainer/post-create-project.sh later)"
    rm -f "$TARBALL.partial"
    exit 0
  fi
  mv "$TARBALL.partial" "$TARBALL"
fi

log "extracting into $INSTALL_DIR…"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if ! tar -xzf "$TARBALL" -C "$INSTALL_DIR" --strip-components=1; then
  log "WARN: extract failed — cached tarball may be corrupt; removing it"
  rm -f "$TARBALL"
  exit 0
fi

ensure_path
log "installed → $("$SWIFT_BIN/swift" --version 2>/dev/null | head -1)"
