#!/usr/bin/env bash
# Symlink Pulse SKILL.md bundles into ~/.hermes/skills/ so Hermes loads them.
#
# Hermes loads skills from ~/.hermes/skills/<skill-name>/SKILL.md by default
# (per https://hermes-agent.nousresearch.com/docs/user-guide/configuration/).
# Our pulse-skills live at packages/plugins/pulse-skills/skills/* — symlinking
# means edits in our repo flow through to Hermes immediately.

set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

SKILLS_SRC="$PWD/packages/plugins/pulse-skills/skills"
SKILLS_DST="${HERMES_HOME:-$HOME/.hermes}/skills"

if [ ! -d "$SKILLS_SRC" ]; then
  echo "✗ Pulse skills source missing at: $SKILLS_SRC"
  exit 1
fi

mkdir -p "$SKILLS_DST"

linked=0
skipped=0

for skill_dir in "$SKILLS_SRC"/*/; do
  skill_name="$(basename "$skill_dir")"
  target="$SKILLS_DST/$skill_name"

  if [ -L "$target" ]; then
    # Existing symlink — refresh it
    rm "$target"
  elif [ -e "$target" ]; then
    echo "⚠ $target exists and is not a symlink; skipping"
    skipped=$((skipped + 1))
    continue
  fi

  ln -s "$skill_dir" "$target"
  echo "✓ linked $skill_name → $skill_dir"
  linked=$((linked + 1))
done

echo
echo "Linked $linked skills, skipped $skipped."
echo "Hermes will load them from: $SKILLS_DST"
echo
echo "If you want to remove these later:"
echo "  for s in pulse-commit pulse-reveal pulse-status-check pulse-gated-swap sealed-inference-with-pulse; do"
echo "    rm \"$SKILLS_DST/\$s\""
echo "  done"
