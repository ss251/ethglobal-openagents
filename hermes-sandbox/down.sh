#!/usr/bin/env bash
# Stop Hermes containers. Two modes:
#   ./down.sh           # stop + remove containers (preserves ~/.hermes auth/skills)
#   ./down.sh --wipe    # also wipes ~/.hermes (auth gone, skills relinked from scratch)

set -euo pipefail

cd "$(dirname "$0")"

WIPE=false
for arg in "$@"; do
  case "$arg" in
    --wipe) WIPE=true ;;
    -h|--help)
      sed -n '2,5p' "$0"
      exit 0
      ;;
  esac
done

if [ -d "upstream" ]; then
  echo "→ stopping containers"
  docker compose \
    -f upstream/docker-compose.yml \
    -f docker-compose.override.yml \
    --project-directory upstream \
    down -v 2>/dev/null || true
fi

if [ "$WIPE" = true ]; then
  echo "→ wiping ~/.hermes (auth, skills, sessions, logs)"
  rm -rf "${HERMES_HOME:-$HOME/.hermes}"
  echo "✓ clean slate"
else
  echo "✓ containers stopped. ~/.hermes preserved (auth + skills)."
  echo "  Use --wipe to start fully clean."
fi
