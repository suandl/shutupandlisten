#!/usr/bin/env bash
# Run a command with eval API keys injected at use-time via 1Password.
# Keys live in-memory for the child process only — nothing lands on disk.
#
# Usage: scripts/eval-keys.sh <command> [args...]
#   e.g. scripts/eval-keys.sh npx promptfoo eval
#
# Auth: uses OP_SERVICE_ACCOUNT_TOKEN if already set (CI passes it as a
# secret); otherwise reads the token file at ~/.config/gascity/op-sa-token
# (override with OP_SA_TOKEN_FILE).
set -euo pipefail
TOKEN_FILE="${OP_SA_TOKEN_FILE:-$HOME/.config/gascity/op-sa-token}"
if [ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
  [ -r "$TOKEN_FILE" ] || { echo "eval-keys: no OP_SERVICE_ACCOUNT_TOKEN and no token file at $TOKEN_FILE" >&2; exit 1; }
  export OP_SERVICE_ACCOUNT_TOKEN="$(cat "$TOKEN_FILE")"
fi
exec op run --env-file="$(dirname "$0")/../promptfoo/.env.op" -- "$@"
