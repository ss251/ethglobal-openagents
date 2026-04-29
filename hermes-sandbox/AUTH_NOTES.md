# Hermes ↔ Claude Code OAuth — debug notes

Three non-obvious things bit us when wiring Claude Pro/Max OAuth into the
sandboxed Hermes container. The first two are fixed by `./auth.sh`; the
third is a usage rule (don't enable the `skills` toolset on Pro/Max
OAuth alone — but binding a non-OAuth API key alongside lifts the rule
entirely; see Finding 3). This file records *why* the script does what
it does, so future readers don't have to repeat the bisection.

## Canonical setup flow (v0.2.0+)

```bash
./up.sh        # build + start container; gateway auto-starts as entrypoint
./auth.sh      # paste Claude Code OAuth + install pulseagent persona

# Bind a non-OAuth Anthropic API key so the agent can invoke pulse-skills
# by name (skills toolset would otherwise bust the OAuth body-size gate
# and hang silently — see Finding 3):
docker exec --user hermes hermes /opt/hermes/.venv/bin/hermes \
  auth add anthropic --type api-key --api-key sk-ant-api03-...

# Configure the Telegram bot (read by hermes gateway automatically):
docker exec --user hermes bash -c '
  echo TELEGRAM_BOT_TOKEN=<from-BotFather> >> /opt/data/.env
  echo TELEGRAM_ALLOWED_USERS=<your-numeric-user-id> >> /opt/data/.env
'
docker restart hermes  # gateway picks up new env on next entrypoint run
```

After that, talk to `@<your-bot>` in Telegram — Hermes gateway is the
entrypoint of the container, so it's already polling and ready. Try:
> sell 0.01 pETH for at least 1800 pUSD

The agent loads the `pulse-autonomous-trade` skill, runs
`scripts/autonomous-trade.ts` via the `terminal` tool, narrates the
commit → wait → atomic-reveal swap cycle in the chat with clickable
Etherscan + ENS links.

The earlier `hermes -z "<prompt>"` one-shot pattern (and the standalone
`scripts/telegram-pulse-bot.ts` polling shim) are gone in v0.2.0 —
neither survives switching to Hermes' native gateway, which provides
persistent sessions, voice memos, group support, and skill auto-load
out of the box.

## Finding 1 — Multiple Keychain entries; default lookup picks a stale one

`security find-generic-password -s "Claude Code-credentials" -w` returns
the **oldest matching entry**, not the one Claude Code is actually
writing fresh tokens to. On a host that's had the CLI installed more
than once you'll see something like:

```
0x00000007 "Claude Code-credentials"           acct="Claude Code"  ← stale (default match)
0x00000007 "Claude Code-credentials-323132a8"  acct="thescoho"
0x00000007 "Claude Code-credentials"           acct="thescoho"     ← live entry
```

The stale one expired months ago; refreshing it returns
`invalid_grant`. The live one is rotated by Claude Code on use and is
keyed by macOS account name. `auth.sh` filters with `-a "$USER"` and
rejects any blob whose `expiresAt` is in the past, so a stale match
fails loud instead of being pasted into the container.

Hermes itself reads `~/.claude/.credentials.json` per
[Auto-Discovery in credential-pools.md](https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-pools)
— this script just bridges the macOS Keychain (where Claude Code 2.1.114+
stores creds) into that file path inside the container.

## Finding 2 — Subscription routing is gated on per-request body size

With "Extra Usage" toggled OFF on
[claude.ai/settings/usage](https://claude.ai/settings/usage), valid
OAuth requests over a threshold get rejected with:

```
{"type":"error","error":{"type":"invalid_request_error",
 "message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."}}
```

The 402 is *not* an auth failure — Anthropic recognized the OAuth token
fine. It means Anthropic chose to bill via the metered "extra usage"
pool instead of the subscription, and that pool is at zero. The signal
they use to choose appears to be **per-request body size**.

Bisected against the live API by varying tool count, holding system
prompt + messages constant:

| tools | body size | endpoint result |
| ---: | ---: | --- |
| 5  | 3,024 b  | ✓ subscription |
| 10 | 6,021 b  | ✓ subscription |
| 15 | 19,303 b | ✓ subscription |
| 18 | 23,192 b | ✓ subscription |
| **19** | **25,433 b** | **402 (extra usage)** |
| 20 | 28,225 b | 402 |
| 25 | 36,353 b | 402 |
| 27 (Hermes default) | 37,839 b | 402 |

Threshold sits between 23 KB and 25 KB. Other knobs we tried — adding a
"You are Claude Code …" system prefix, varying `max_tokens`, varying
beta header combinations — make no difference. Only request size does.

Hermes ships 27 tools by default plus a ~13 KB built-in system prompt,
so every request lands at ~35 KB and trips the gate. `auth.sh` disables
the heavyweight tool sets and empties `SOUL.md`:

```bash
hermes tools disable web browser vision image_gen tts session_search \
  clarify delegation cronjob messaging code_execution memory todo
```

That leaves `terminal`, `file`, plus whatever the user re-enables, and
the typical body lands ~22 KB — under the gate.

If you need a tool that's been disabled, run
`hermes tools enable <name>` and re-test the body size with
`ls -t /opt/data/sessions/request_dump_*.json | head -1` — Hermes only
writes a request dump on error, so a missing dump after a successful
turn means you're under the gate.

## Finding 3 — `skills` toolset is body-gated on Pro/Max OAuth; API key lifts it

Pulse skills load fine in `hermes skills list` (all five show as
`local`/`enabled`), but **the `skills` *toolset* itself is disabled by
default** and re-enabling it on a Pro/Max OAuth session pushes the
request body past the Finding-2 threshold. The symptom is
*non-obvious*: the call hangs silently — even a plain "say PONG"
prompt produces no output and no error — because Anthropic's 402 is
returned mid-stream and Hermes' OAuth path swallows it.

```bash
# Under OAuth-only, this breaks even PONG:
docker exec --user hermes hermes hermes tools enable skills
```

### Escape route — bind a non-OAuth API key alongside the OAuth credential

A regular Anthropic API key (`sk-ant-api03-…`) doesn't go through the
subscription-routing layer at all, so the body-size gate doesn't apply.
Bind it once and Hermes' credential pool rotates to it whenever the
OAuth token throws any pool error (rate-limit, refresh failure, the
mysterious silent 402):

```bash
docker exec --user hermes hermes /opt/hermes/.venv/bin/hermes \
  auth add anthropic --type api-key --api-key sk-ant-api03-…

docker exec --user hermes hermes /opt/hermes/.venv/bin/hermes auth list
# anthropic (2 credentials):
#   #1  api-key-2            api_key manual ←
#   #2  claude_code          oauth
```

With the API key in the pool, **`hermes tools enable skills` works**
and the agent invokes pulse-skills by name via the SkillUse tool:

```bash
docker exec --user hermes hermes /opt/hermes/.venv/bin/hermes \
  -z "Use the pulse-status-check skill to read commitment id 8 on Eth Sepolia. …" \
  --provider anthropic -m claude-haiku-4-5
```

Confirmed working: haiku-4-5 picks the skill, follows the SKILL.md
recipe via viem, and surfaces the full provenance trail
(`pulseagent.eth`, ERC-8004 #3906, signer provider, reasoning CID,
`overdueExpired` ⇒ "watcher should call `markExpired(8)`") in one
turn.

### When OAuth-only is fine

If you only need the agent to use `terminal` and `file` (no
`skills` / `web` / `browser` / etc.), the trimmed-tools setup is
strictly cheaper — the agent invokes recipe-equivalent scripts under
`scripts/` (e.g. `bun run scripts/pulse-status.ts <id>`) instead of
SkillUse. Both shapes are first-class. Reach for the API key only when
you want the LLM to auto-discover and chain skills by name.

## Independent provider key as a fallback

Subscription gating only applies to OAuth tokens. A regular Anthropic
API key (`sk-ant-api03-…`) bypasses the threshold entirely:

```bash
docker exec -it --user hermes hermes hermes auth add anthropic \
  --type api-key --api-key sk-ant-api03-…
```

Hermes will rotate to the API key automatically when the OAuth credential
hits any pool error (rate limit, exhaustion, refresh failure) — see the
[credential pool error matrix](https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-pools#error-recovery).

## 0G Compute is wired the same way

`hermes-sandbox/.env` carries `ZG_API_KEY`, `ZG_BROKER_URL`,
`ZG_SIGNER_ADDRESS`, `ZG_MODEL`. `docker-compose.override.yml` loads it
via `env_file: ../.env` (the path is `../.env` because compose runs with
`--project-directory upstream`, so relative paths resolve from
`hermes-sandbox/upstream/`). Verified inside the container with:

```bash
docker exec hermes bash -c 'cd /workspace/ethglobal-openagents && \
  bun run scripts/sealed-inference-demo.ts'
```

This runs the full path: 0G qwen-2.5-7b-instruct generates reasoning →
hash to `reasoningCID` → Pulse.commit on Eth Sepolia (`commitmentId 6`,
tx `0x810718ce64de40cece67f7c62776753dfa10a63778e4868dd9ac48ea08a0e713`
in `deployments/sepolia.json` under `validatedFlows`).

## Verifying end-to-end

The canonical demo from v0.2.0 onward is **chat-driven via Telegram**, not a one-shot CLI invocation. Open Telegram → `@<your-bot>` → message:

> sell 0.01 pETH for at least 1800 pUSD

Hermes:

1. Routes the message to the persistent session for your `chat_id` (sessions live at `/opt/data/sessions/`, FTS5-indexed via SQLite).
2. Loads the `pulse-autonomous-trade` skill via SkillUse (the API-key path; see Finding 3).
3. Calls `bun run scripts/autonomous-trade.ts --direction sell --base-amount 0.01 --min-price 1800 --execute-after 30` via the `terminal` tool.
4. The script runs the full reason → commit → wait → atomic-reveal cycle on Eth Sepolia, prints progress to stderr, emits a single JSON object to stdout.
5. Hermes parses the JSON and replies in the chat with clickable Etherscan + ENS links.

For the force-drift demo (the rhetorical hammer):

> Now drift the agent — execute a swap with different params

Hermes runs `scripts/force-drift.ts`; the v4 hook reverts the drifted swap pre-state-change; the watcher closes the rollback gap with a direct `Pulse.reveal(drifted)`; the commitment goes Violated; the agent gets slashed -1000 ERC-8004 reputation. All visible inline.

**Why this shape is the right one** (vs the older `hermes -z` polling shim):

- Native Telegram persistence — sessions, voice memos, group chats, slash commands, model picker (`/model`), reset (`/new`) all work for free.
- Cron, memory, todo, clarify tools available — agent can actually live as a long-running process, schedule autonomous portfolio checks, remember user context across sessions.
- Skill auto-load by `/skill-name` slash command, or by name in natural-language requests.
- One source of truth for env: `/opt/data/.env` is what `hermes gateway` reads. No host/container env mirror dance.
