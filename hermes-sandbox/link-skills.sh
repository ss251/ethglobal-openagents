#!/usr/bin/env bash
# Sync Pulse SKILL.md bundles into ~/.hermes/skills/ so Hermes loads them.
#
# Hermes loads skills from ~/.hermes/skills/<skill-name>/SKILL.md by default
# (per https://hermes-agent.nousresearch.com/docs/user-guide/configuration/).
# Our pulse-skills live at packages/plugins/pulse-skills/skills/*.
#
# We rsync (not symlink) because the Hermes Docker container bind-mounts
# ~/.hermes into /opt/data — symlinks pointing back into the repo path
# can't be resolved from inside the container.
#
# Re-run this script whenever you edit a SKILL.md.

set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

SKILLS_SRC="$PWD/packages/plugins/pulse-skills/skills"
SKILLS_DST="${HERMES_HOME:-$HOME/.hermes}/skills"

if [ ! -d "$SKILLS_SRC" ]; then
  echo "✗ Pulse skills source missing at: $SKILLS_SRC"
  exit 1
fi

mkdir -p "$SKILLS_DST"

synced=0
removed=0

for skill_dir in "$SKILLS_SRC"/*/; do
  skill_name="$(basename "$skill_dir")"
  target="$SKILLS_DST/$skill_name"

  if [ -L "$target" ]; then
    rm "$target"
    removed=$((removed + 1))
  fi

  rsync -a --delete "$skill_dir" "$target/"
  echo "✓ synced $skill_name"
  synced=$((synced + 1))
done

echo
echo "Synced $synced skill(s) (removed $removed dangling symlinks)."
echo "Hermes loads them from: $SKILLS_DST"
echo
echo "Removal:"
echo "  for s in pulse-commit pulse-reveal pulse-status-check pulse-gated-swap sealed-inference-with-pulse; do"
echo "    rm -rf \"$SKILLS_DST/\$s\""
echo "  done"
