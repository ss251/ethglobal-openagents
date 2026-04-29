#!/usr/bin/env bash
# Wire Claude Code's Anthropic OAuth into the running Hermes sandbox.
#
# Hermes auto-discovers Claude Code credentials from ~/.claude/.credentials.json
# and seeds them into the Anthropic credential pool — see:
#   https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-pools  (Auto-Discovery table)
#   https://hermes-agent.nousresearch.com/docs/integrations/providers              (Anthropic / Claude Pro/Max via Claude Code auth)
#
# On macOS Claude Code stores creds in the Keychain ("Claude Code-credentials"),
# not on disk. This script:
#   1. Pulls the credentials JSON out of the Keychain (macOS) or reads
#      ~/.claude/.credentials.json directly (Linux).
#   2. Drops it into /opt/data/.claude/.credentials.json inside the running
#      hermes container — the path Hermes auto-discovers (Path.home() inside
#      the container resolves to /opt/data per the upstream Dockerfile's
#      HERMES_HOME env).
#   3. Sets `model.provider: "anthropic"` in /opt/data/config.yaml so Hermes
#      picks the Anthropic provider (otherwise auto-routing can pick a
#      Bearer-token-incompatible fallback).
#
# After this, `hermes auth status anthropic` shows `logged in (claude_code)`
# and Hermes uses the OAuth token (with auto-refresh) for inference. No
# tokens are copied into ~/.hermes/.env — Claude Code stays the single
# source of truth, which is the upstream-documented preference.

set -euo pipefail

cd "$(dirname "$0")"

if ! docker ps --format '{{.Names}}' | grep -qx hermes; then
  echo "✗ hermes container not running — run ./up.sh first"
  exit 1
fi

# ── 1. extract creds ─────────────────────────────────────────────────────
TMP_CREDS="$(mktemp -t cc-creds.XXXXXX.json)"
trap 'rm -f "$TMP_CREDS"' EXIT

if [ "$(uname)" = "Darwin" ]; then
  # Claude Code stores multiple Keychain entries (per-install, per-account).
  # The live one — the entry Claude Code currently writes refreshed tokens
  # back to — is keyed by macOS account name. Without -a, security returns
  # the OLDEST matching entry, which is typically a long-expired token from
  # a prior install. Pin to the current account so we read the fresh blob.
  echo "→ reading 'Claude Code-credentials' (acct=$USER) from macOS Keychain"
  if security find-generic-password -s "Claude Code-credentials" -a "$USER" -w > "$TMP_CREDS" 2>/dev/null; then
    : # ok
  elif security find-generic-password -s "Claude Code-credentials" -w > "$TMP_CREDS" 2>/dev/null; then
    echo "  ⚠ falling back to first-match entry (no per-account match for $USER)"
  else
    echo "✗ no 'Claude Code-credentials' entry in Keychain. Sign into Claude Code first."
    exit 1
  fi
  # Sanity-check expiry. A blob with expiresAt in the past means the entry
  # is stale (the live token lives in a different Keychain item we missed).
  python3 - "$TMP_CREDS" <<'PY' || { echo "✗ token in selected Keychain entry has already expired — pick a different one"; exit 1; }
import json, sys, time
with open(sys.argv[1]) as f: o = json.load(f)["claudeAiOauth"]
remaining = (o["expiresAt"] - int(time.time()*1000)) / 1000
print(f"  ✓ token expires in {remaining/60:.1f} min (scopes={','.join(o.get('scopes',[]))})")
sys.exit(0 if remaining > 60 else 1)
PY
elif [ -f "$HOME/.claude/.credentials.json" ]; then
  echo "→ reading $HOME/.claude/.credentials.json"
  cp "$HOME/.claude/.credentials.json" "$TMP_CREDS"
else
  echo "✗ no Claude Code credentials found (Keychain or ~/.claude/.credentials.json)."
  echo "  Sign into Claude Code on this host first."
  exit 1
fi

# Sanity check the structure — reject nonsense before pasting into the container.
if ! grep -q '"claudeAiOauth"' "$TMP_CREDS"; then
  echo "✗ creds blob doesn't look like Claude Code OAuth (no claudeAiOauth key)"
  exit 1
fi

# ── 2. drop into container at the doc-canonical path ─────────────────────
echo "→ writing /opt/data/.claude/.credentials.json (mode 600, owned by hermes)"
docker cp "$TMP_CREDS" hermes:/tmp/cc-creds.json
docker exec --user root hermes bash -c '
  install -d -o hermes -g dialout -m 700 /opt/data/.claude
  install -o hermes -g dialout -m 600 /tmp/cc-creds.json /opt/data/.claude/.credentials.json
  rm -f /tmp/cc-creds.json
'

# ── 3. ensure model.provider is anthropic ────────────────────────────────
echo "→ pinning model.provider: anthropic in /opt/data/config.yaml"
# sed -i in BSD/GNU compatible form. The patterns target the only
# uncommented "provider:" and OpenRouter base_url lines under model:.
docker exec --user hermes hermes bash <<'BASH'
set -e
cp /opt/data/config.yaml /opt/data/config.yaml.bak
sed -i 's|^\(  provider: \).*$|\1"anthropic"|' /opt/data/config.yaml
sed -i 's|^\(  base_url: \"https://openrouter.ai/api/v1\"\)$|  # base_url disabled — using anthropic provider|' /opt/data/config.yaml
echo "  ✓ model.provider set, OpenRouter base_url commented"
BASH

# ── 4. trim tool surface for Claude Max subscription gating ──────────────
# Anthropic's subscription-quota path (Claude Pro/Max via OAuth) appears to
# gate inference at the per-request body size — discovered by bisection:
# requests with the default Hermes 27-tool catalog (~35KB) get billed via
# "extra usage" and 402 with extra-usage off; trimming to the file/terminal
# essentials keeps the body under the threshold and routes to subscription.
# Re-enable any toolset interactively with `hermes tools enable <name>`.
echo "→ disabling toolsets that don't fit Claude subscription gating"
docker exec --user hermes hermes bash -c '
  export PATH=/opt/hermes/.venv/bin:$PATH
  hermes tools disable web browser vision image_gen tts session_search clarify delegation cronjob messaging code_execution memory todo 2>&1 | tail -2
' || true

# Empty SOUL.md so the persona block doesn't bloat the system prompt either.
docker exec --user hermes hermes bash -c '
  if [ -s /opt/data/SOUL.md ] && [ ! -f /opt/data/SOUL.md.bak ]; then
    cp /opt/data/SOUL.md /opt/data/SOUL.md.bak
    : > /opt/data/SOUL.md
    echo "  ✓ emptied /opt/data/SOUL.md (backup at SOUL.md.bak)"
  fi
'

# ── 5. report ────────────────────────────────────────────────────────────
echo
echo "→ hermes auth status anthropic:"
docker exec --user hermes hermes bash -c 'export PATH=/opt/hermes/.venv/bin:$PATH && hermes auth status anthropic'
echo
echo "→ hermes auth list:"
docker exec --user hermes hermes bash -c 'export PATH=/opt/hermes/.venv/bin:$PATH && hermes auth list'
echo
echo "✓ Anthropic OAuth wired. To send a one-shot prompt:"
echo "    docker exec -it --user hermes hermes hermes -z \"<your prompt>\" --provider anthropic -m claude-haiku-4-5"
echo
echo "Note: this credential is a Claude Pro/Max subscription token. Concurrent"
echo "      Claude Code load on the same account can return 402 'out of usage'"
echo "      from Anthropic — that's account-level, not Hermes auth. Add a"
echo "      second credential for the same provider to enable pool rotation:"
echo "        docker exec -it --user hermes hermes hermes auth add anthropic --type api-key"
