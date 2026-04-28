#!/usr/bin/env bash
# Clone upstream Hermes Agent and prepare it for use as a sandboxed runner
# for the Pulse skills bundle.
#
# Why upstream verbatim: Hermes is Python+Node, has its own Docker setup,
# loads SKILL.md from ~/.hermes/skills/, and supports Anthropic OAuth via
# Claude Code's credential store. The right move is to use their image as-is
# and layer our customization via docker-compose.override.yml.
#
# Refs:
#   https://hermes-agent.nousresearch.com/docs/getting-started/quickstart
#   https://hermes-agent.nousresearch.com/docs/integrations/providers
#   https://github.com/NousResearch/hermes-agent

set -euo pipefail

cd "$(dirname "$0")"

UPSTREAM_DIR="upstream"
UPSTREAM_REMOTE="https://github.com/NousResearch/hermes-agent.git"
UPSTREAM_REF="${HERMES_REF:-main}"

if [ -d "$UPSTREAM_DIR" ]; then
  echo "→ $UPSTREAM_DIR exists; pulling latest $UPSTREAM_REF"
  git -C "$UPSTREAM_DIR" fetch origin "$UPSTREAM_REF"
  git -C "$UPSTREAM_DIR" checkout "$UPSTREAM_REF"
  git -C "$UPSTREAM_DIR" pull --ff-only origin "$UPSTREAM_REF"
else
  echo "→ cloning $UPSTREAM_REMOTE @ $UPSTREAM_REF into $UPSTREAM_DIR"
  git clone --depth 50 --branch "$UPSTREAM_REF" "$UPSTREAM_REMOTE" "$UPSTREAM_DIR"
fi

echo
echo "✓ Hermes upstream ready at: hermes-sandbox/$UPSTREAM_DIR"
echo "  Version info:"
git -C "$UPSTREAM_DIR" log -1 --pretty=format:'    %h %s (%ad)%n' --date=short
echo
echo "Next steps:"
echo "  1. ./link-skills.sh        # symlink Pulse skills into ~/.hermes/skills/"
echo "  2. ./auth.sh               # one-time Claude OAuth (uses your existing Claude Code creds if present)"
echo "  3. ./up.sh                 # build + run Hermes in Docker"
