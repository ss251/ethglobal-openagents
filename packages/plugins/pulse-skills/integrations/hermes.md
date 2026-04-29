# Hermes integration

Hermes (NousResearch/hermes-agent) is the agent runtime we used to build the
`pulseagent.eth` Telegram bot in this repo. Pulse skills slot in as
*native* SkillUse skills — no custom tool registration, no YAML config — by
symlinking the bundle into the container's skills directory.

This recipe is the canonical "Pulse + Hermes" wiring. Tested end-to-end
with a Telegram gateway, persistent SQLite sessions, voice memos via
Whisper, and the full 9-skill bundle loaded by name.

## Ground-truth setup (what actually runs in this repo)

Files:

- [`hermes-sandbox/up.sh`](../../../../hermes-sandbox/up.sh) — build container, install bun, link skills.
- [`hermes-sandbox/auth.sh`](../../../../hermes-sandbox/auth.sh) — paste Claude Code OAuth, install pulseagent SOUL.md persona.
- [`hermes-sandbox/link-skills.sh`](../../../../hermes-sandbox/link-skills.sh) — symlink Pulse skills into container.
- [`hermes-sandbox/SOUL.md`](../../../../hermes-sandbox/SOUL.md) — agent persona that references each skill by name.
- [`hermes-sandbox/AUTH_NOTES.md`](../../../../hermes-sandbox/AUTH_NOTES.md) — three non-obvious blockers and their fixes.

```bash
./hermes-sandbox/up.sh        # builds container, runs link-skills.sh
./hermes-sandbox/auth.sh      # OAuth + SOUL.md install

# Bind a non-OAuth Anthropic API key alongside the OAuth credential.
# Required for the `skills` toolset under Pro/Max OAuth — see AUTH_NOTES
# Finding 3 (the body-size gate silently 402s otherwise).
docker exec --user hermes hermes /opt/hermes/.venv/bin/hermes \
  auth add anthropic --type api-key --api-key sk-ant-api03-...

# Telegram bot config goes into /opt/data/.env (gateway auto-reads on start)
docker exec --user hermes bash -c '
  echo TELEGRAM_BOT_TOKEN=<from-BotFather> >> /opt/data/.env
  echo TELEGRAM_ALLOWED_USERS=<your-numeric-user-id> >> /opt/data/.env
'
docker restart hermes
```

That's it. The Hermes gateway is now:

- polling Telegram in a persistent session keyed by `chat_id`,
- routing voice memos through Whisper for transcription,
- loading `pulseagent.eth`'s SOUL.md persona on every turn,
- exposing the full Hermes tool catalog (terminal, file, memory, cronjob,
  todo, clarify, skills) including the `skills` toolset that lets the
  agent invoke any of the 9 Pulse skills *by name* via SkillUse.

## How the agent picks a Pulse skill

The agent reads SOUL.md, sees the skill table, and SkillUse-invokes
whichever skill the user prompt maps onto. From the v0.3 prod-readiness
test, given the un-coached prompt:

> What's the status of my recent Pulse commitments?

…the agent autonomously loaded `pulse-status-check`, ran
`bun run scripts/pulse-introspect.ts` (the v0.3 helper), then chained
`bun run scripts/pulse-status.ts <id>` per discovered commitment, and
produced a clean 7-row Telegram table with every Revealed / Violated /
Pending state — without any explicit skill name in the prompt.

## ERC-7857 iNFT path

The `pulse-inft` skill points the agent at `scripts/inft-bind.ts`. No
extra Hermes wiring needed — the agent calls the helper script via the
existing `terminal` tool. Sample Telegram interaction:

> User: Mint my agent state as an iNFT on 0G with my last 10 commitments.
>
> Agent (autonomous): SkillUse → `pulse-inft` → `terminal` → `bun run
> scripts/inft-bind.ts --commitments 9,12,13,14,15,21,23,24,25,26
> --description "pulse-agent-state-v0.4" --set-ens-text` → reads JSON
> output → narrates result with chainscan link.

If you want the iNFT mint to happen as a *direct API call* from a custom
Hermes plugin instead of via the helper script, import from `@pulse/sdk`
(see the [Anthropic SDK recipe](./anthropic-sdk.md#erc-7857-inft--pulse_inft_mint-tool)
for the verbatim handler — same pattern, swap the tool registration for
your Hermes plugin's API).

## Reading state

For commitment-state queries the agent uses the `terminal` tool to run
`bun run scripts/pulse-status.ts <id>` (or `pulse-introspect.ts
--commitment-id <id>`). The SKILL.md tells the agent *when* to use which
helper; the helper itself wraps `@pulse/sdk` reads.

## What this recipe does NOT cover

- Custom Hermes plugins that bypass SkillUse (you'd register your own tool
  with the Hermes plugin API; out of scope here — the SkillUse path is the
  canonical Hermes-native way).
- Non-Telegram gateways (Discord, IRC, etc.) — Hermes supports them but we
  only verified Telegram in this repo.

## Why the polling shim is gone

A previous version (v0.1.5) wrapped `docker exec hermes hermes -z "..."`
for every Telegram message via a custom `scripts/telegram-pulse-bot.ts`.
v0.2.0 deleted it because Hermes' native gateway is the canonical shape:
persistent sessions, voice memos, group chats, slash commands, skill
auto-load, cron, memory, todo — all of which were re-implemented (badly)
in the polling shim. We followed the docs.
