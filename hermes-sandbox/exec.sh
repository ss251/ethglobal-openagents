#!/usr/bin/env bash
# Drop into the running Hermes container. Useful for:
#   - hermes auth add anthropic --type oauth   # one-time auth
#   - hermes chat                              # interactive session
#   - hermes config                            # inspect config
#   - hermes doctor                            # diagnose issues

set -euo pipefail

if [ -z "$(docker ps -q -f name=^hermes$)" ]; then
  echo "✗ hermes container not running — start it with ./up.sh"
  exit 1
fi

# If args provided, run them as a hermes command. Otherwise drop into shell.
if [ $# -eq 0 ]; then
  docker exec -it hermes bash
else
  docker exec -it hermes hermes "$@"
fi
