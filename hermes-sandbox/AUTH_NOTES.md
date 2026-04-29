# Hermes ↔ Claude Code OAuth — debug notes

Three non-obvious things bit us when wiring Claude Pro/Max OAuth into the
sandboxed Hermes container. The first two are fixed by `./auth.sh`; the
third is a usage rule (don't enable the `skills` toolset on Pro/Max).
This file records *why* the script does what it does, so future readers
don't have to repeat the bisection.

## Setup flow

```bash
./up.sh        # build + start container, install bun
./auth.sh      # paste Claude Code OAuth + trim tools for subscription routing
docker exec -it --user hermes hermes hermes \
  -z "<your prompt>" --provider anthropic -m claude-haiku-4-5
```

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

## Finding 3 — `skills` toolset can't be enabled under Pro/Max gating

Pulse skills load fine in `hermes skills list` (all five show as
`local`/`enabled`), but **the `skills` *toolset* itself is disabled by
default** and re-enabling it on a Pro/Max OAuth session pushes the
request body past the Finding-2 threshold. The symptom is
*non-obvious*: the call hangs silently — even a plain "say PONG"
prompt produces no output and no error — because Anthropic's 402 is
returned mid-stream and Hermes' OAuth path swallows it.

```bash
# This breaks PONG under Pro/Max OAuth:
docker exec --user hermes hermes hermes tools enable skills

# Restoring it:
docker exec --user hermes hermes hermes tools disable skills
```

The practical consequence: under Pro/Max OAuth, agents **cannot invoke
pulse-skills by name via the SkillUse tool.** They use the `terminal`
tool to run scripts that implement the skill's recipe instead. For a
status check that's `bun run scripts/pulse-status.ts <id>`, etc.

This is fine for the in-house Pulse demos (every skill has a paired TS
script under `scripts/`), but worth knowing if you want the LLM to
auto-discover skills from the `pulse-skills` bundle on a subscription
account. Add a non-OAuth API key (see *Independent provider key* below)
to escape the gate entirely.

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

A real Hermes → Pulse round trip on Eth Sepolia, Claude Haiku 4.5 via
the Max subscription, with trimmed tools:

```bash
docker exec --user hermes hermes /opt/hermes/.venv/bin/hermes \
  -z "Working dir: /workspace/ethglobal-openagents. Use the terminal tool to run 'bun run scripts/pulse-status.ts 8'. Status enum: 0=Pending, 1=Revealed, 2=Violated, 3=Expired. Note: status==0 with overdueExpired==true means the commitment is past revealDeadline but not yet markExpired'd — a watcher must call Pulse.markExpired(id) to lock in status 3 and trigger the -500 ERC-8004 slash. Report (a) status code + name, (b) reveal-window state, (c) action the watcher should take." \
  --provider anthropic -m claude-haiku-4-5
```

Two things `cast` users should know up front:

- **`cast` is not installed in the upstream Hermes image.** `up.sh`
  installs `bun` post-start; viem-via-bun is the supported path. If you
  want `cast`, install `foundry` separately or write the agent prompt
  to use `bun -e` / a script under `scripts/`.
- **Confirmed working against `commitment id 8`** — the ENS-bound
  commitment from `scripts/ens-bind-demo.ts`. Haiku invoked
  `bun run scripts/pulse-status.ts 8` via its terminal tool, parsed
  the output, and correctly recommended `markExpired(8)` once the
  prompt clarified `overdueExpired` semantics. Without that semantic
  hint, the smaller model interpreted `overdueExpired==true` as
  "already expired, no action needed" — caller's job to disambiguate
  in the prompt or move up to a stronger model.
