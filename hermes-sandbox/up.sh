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

echo
echo "✓ Hermes is running."
echo
echo "Useful commands:"
echo "  ./exec.sh                                # drop into hermes shell inside container"
echo "  docker compose -f upstream/docker-compose.yml ps"
echo "  docker compose -f upstream/docker-compose.yml logs -f gateway"
echo "  open http://localhost:9119               # dashboard (localhost-only)"
echo "  ./down.sh                                # stop + clean up"
