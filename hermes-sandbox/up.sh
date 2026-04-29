#!/usr/bin/env bash
# Build + start Hermes (gateway + dashboard) using upstream's compose with
# our override layered on top.

set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d "upstream" ]; then
  echo "✗ ./upstream missing — run ./install.sh first"
  exit 1
fi

if [ ! -f "../.env" ] && [ ! -f "./.env" ]; then
  echo "⚠ no .env at repo root or in hermes-sandbox/"
  echo "  Hermes will run but won't have Pulse contract addresses or Trading API keys."
  echo "  Continue anyway? [y/N]"
  read -r yn
  [[ "$yn" =~ ^[Yy]$ ]] || exit 0
fi

export HERMES_UID
export HERMES_GID
HERMES_UID="$(id -u)"
HERMES_GID="$(id -g)"

echo "→ Building + starting Hermes (this can take 5–10 min on first build)"
echo "  HERMES_UID=$HERMES_UID  HERMES_GID=$HERMES_GID"
echo

docker compose \
  -f upstream/docker-compose.yml \
  -f docker-compose.override.yml \
  --project-directory upstream \
  up -d --build

# Pulse skills shell out to `bun run scripts/...`. Hermes upstream's image
# ships node+npm but not bun, so install it post-start as root. Idempotent:
# bun's npm package skips the binary fetch if one is already present.
echo
echo "→ Ensuring bun is installed in the container (needed for pulse-skills)…"
docker exec --user root hermes bash -c 'command -v bun >/dev/null || npm install -g --silent bun' 2>&1 | tail -5 || true
docker exec hermes bash -c 'echo "  bun: $(bun --version 2>/dev/null || echo missing)"'

echo
echo "✓ Hermes is running."
echo
echo "Useful commands:"
echo "  ./exec.sh                                # drop into hermes shell inside container"
echo "  docker compose -f upstream/docker-compose.yml ps"
echo "  docker compose -f upstream/docker-compose.yml logs -f gateway"
echo "  open http://localhost:9119               # dashboard (localhost-only)"
echo "  ./down.sh                                # stop + clean up"
