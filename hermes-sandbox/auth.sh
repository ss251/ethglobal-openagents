#!/usr/bin/env bash
# Set up Anthropic OAuth for Hermes using Claude Code's credential store.
#
# Hermes prefers Claude Code's own credential store over copying the token
# into ~/.hermes/.env. That keeps refreshable Claude credentials refreshable.
# Source: https://hermes-agent.nousresearch.com/docs/integrations/providers
#
# This script runs OAuth on the host (not in Docker) because:
#   - The OAuth flow opens a browser
#   - Containerized Hermes inherits ~/.hermes via the volume mount, so
#     credentials set up here are picked up automatically inside the sandbox

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v hermes >/dev/null 2>&1; then
  echo "→ 'hermes' CLI not found on host — installing via upstream script"
  echo "  (skip this if you want the sandbox to be the only Hermes install;"
  echo "   in that case run auth from inside the container after ./up.sh)"
  read -rp "Install Hermes on host? [y/N] " yn
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
    # shellcheck disable=SC1091
    [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" || true
    [ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" || true
  else
    echo
    echo "Skipping host install. To auth from inside the container instead:"
    echo "  ./up.sh"
    echo "  docker exec -it hermes hermes auth add anthropic --type oauth"
    exit 0
  fi
fi

echo
echo "→ Adding Anthropic OAuth credentials"
echo "  This opens a browser. If you already have Claude Code authenticated,"
echo "  Hermes will reuse those credentials and you'll see no browser prompt."
echo
hermes auth add anthropic --type oauth

echo
echo "✓ Auth complete. Verify with: hermes auth list"
echo "  Credentials live at: ~/.hermes/auth.json (or via Claude Code store)"
