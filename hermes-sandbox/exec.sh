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
# Always run as the `hermes` user (not container root) and source the venv so
# the `hermes` binary is on PATH. Set workdir to the mounted repo so any skill
# that shells out to `bun run scripts/...` resolves relative paths cleanly.
if [ $# -eq 0 ]; then
  docker exec -it -u hermes -w /workspace/ethglobal-openagents hermes \
    bash -c 'source /opt/hermes/.venv/bin/activate && exec bash'
else
  docker exec -it -u hermes -w /workspace/ethglobal-openagents hermes \
    bash -c "source /opt/hermes/.venv/bin/activate && exec hermes $(printf ' %q' "$@")"
fi
