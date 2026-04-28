# Hermes/Pulse sandbox

Run Pulse's skills bundle inside [Hermes Agent](https://github.com/NousResearch/hermes-agent),
sandboxed via Hermes's official Docker setup. Local-only, ephemeral,
Claude-OAuth-backed (no API billing for personal Claude subscribers).

## Why this exists

Hermes is the right host for our `pulse-skills` bundle: it loads SKILL.md
files from `~/.hermes/skills/`, supports Anthropic OAuth via Claude Code's
credential store, and ships its own production Dockerfile. Rather than
reimplement the agent loop, we use Hermes verbatim and layer Pulse on top
via skill symlinks + a docker-compose override.

Refs:
- [Hermes quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)
- [Anthropic provider docs](https://hermes-agent.nousresearch.com/docs/integrations/providers)
- [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration/)
- [Hermes GitHub](https://github.com/NousResearch/hermes-agent)

## Quick start

```bash
# 1. Clone upstream Hermes (one-time)
./install.sh

# 2. Symlink our pulse skills into ~/.hermes/skills/
./link-skills.sh

# 3. Set up Claude OAuth on the host (one-time)
#    Reuses Claude Code creds if you already have them — no browser prompt.
./auth.sh

# 4. Drop a .env at repo root (gitignored). Use env.example as the template.
#    Hermes will mount it into the container.

# 5. Build + run (5–10 min for first build, fast after that)
./up.sh

# 6. Drop into the container shell to interact with Hermes
./exec.sh                         # bash inside container
./exec.sh chat                    # `hermes chat` non-shell
./exec.sh doctor                  # diagnose

# 7. Stop when done
./down.sh                         # stop, preserve ~/.hermes auth + skills
./down.sh --wipe                  # nuclear option: wipe ~/.hermes
```

## File layout

```
hermes-sandbox/
├── install.sh                    # clone + update upstream Hermes
├── link-skills.sh                # symlink Pulse skills into ~/.hermes/skills/
├── auth.sh                       # one-time Claude OAuth setup
├── up.sh                         # docker compose up (build + start)
├── down.sh                       # stop containers; --wipe also nukes ~/.hermes
├── exec.sh                       # drop into container or run hermes subcommand
├── docker-compose.override.yml   # our customization layered on upstream compose
├── .gitignore                    # ignores upstream/ + local .env
└── upstream/                     # cloned NousResearch/hermes-agent (gitignored)
```

## How sandboxing works

The Hermes upstream Docker image already provides:
- Non-root user (`hermes`, UID 10000 by default; remappable via HERMES_UID)
- Tini for signal handling
- Volume-mounted `~/.hermes` for persistent config, auth, skills, sessions

Our `docker-compose.override.yml` adds:
- HERMES_UID/HERMES_GID set to host user (so `~/.hermes` files stay
  readable/writable on the host)
- Our `.env` mounted via `env_file` (Pulse contract addresses, Trading API
  key, the agent's throwaway Sepolia key)
- Resource caps (2 CPU, 2G RAM for gateway; 1 CPU, 512M for dashboard)
- `no-new-privileges` security option

**What we did NOT change**: upstream uses `network_mode: host` for the
gateway/dashboard local link. Switching to bridge would break the dashboard
URL. If you need stricter network isolation, follow upstream's "remote
access via SSH tunnel" guidance — `network_mode: host` is fine for
local-only use.

## Skill loading

`./link-skills.sh` creates symlinks:

```
~/.hermes/skills/pulse-commit          → packages/plugins/pulse-skills/skills/pulse-commit
~/.hermes/skills/pulse-reveal          → packages/plugins/pulse-skills/skills/pulse-reveal
~/.hermes/skills/pulse-status-check    → ...
~/.hermes/skills/pulse-gated-swap      → ...
~/.hermes/skills/sealed-inference-with-pulse → ...
```

Edits in `packages/plugins/pulse-skills/skills/*/SKILL.md` flow through to
Hermes immediately — no rebuild required.

## Auth

Hermes prefers Claude Code's credential store. Two paths:

1. **You already have Claude Code authenticated** (most common):
   `./auth.sh` will reuse those credentials. Hermes calls Claude through
   your existing subscription — **no API billing**.
2. **Fresh setup**: `./auth.sh` runs `hermes auth add anthropic --type oauth`,
   which opens a browser. Token gets stored via Claude Code's store (or
   `~/.hermes/auth.json` as fallback).

To verify after setup: `./exec.sh auth list`.

## Tear down

```bash
./down.sh                # stop + remove containers; preserve ~/.hermes
./down.sh --wipe         # also rm -rf ~/.hermes (auth + skills + sessions gone)
```

For a fully clean slate including the upstream clone:
```bash
./down.sh --wipe
rm -rf upstream
```

Next `./install.sh` re-clones from scratch.

## Limitations / things to know

- **First build takes 5–10 min** — upstream's image installs Playwright
  browsers, full Python venv with `[all]` extras, npm deps for the dashboard
  and TUI. Subsequent builds are cached.
- **`network_mode: host` means the container shares your host network**.
  No published ports needed, but the gateway can reach localhost services.
  If that's a concern for your threat model, follow upstream's remote-access
  guide and switch to bridge mode.
- **Hermes is a real running agent** — once authenticated, it can spawn
  subprocesses (MCP servers, git, npm, browsers via Playwright). That's the
  point. The resource caps in our override prevent runaway processes from
  eating the host.
- **Skills are symlinked, not copied**. Edits in our repo are live. Don't
  delete `packages/plugins/pulse-skills/skills/*` while Hermes is running
  or skills will silently break.
