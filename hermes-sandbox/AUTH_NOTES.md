# Hermes ↔ Claude Code OAuth — debug notes

Two non-obvious things bit us when wiring Claude Pro/Max OAuth into the
sandboxed Hermes container. Both are fixed by `./auth.sh`; this file
records *why* the script does what it does, so future readers don't have
to repeat the bisection.

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
hash to `reasoningCID` → Pulse.commit on Base Sepolia. Last verified
commit: `commitmentId 18`, tx `0x549887707efc28d0548e5ed0494ef2d62bf2110bf196551f2cd5e522cb3a4914`.

## Verifying end-to-end

A real Hermes → Pulse round trip on Base Sepolia (Claude Haiku 4.5 via
the Max subscription, with trimmed tools):

```bash
docker exec -it --user hermes hermes hermes \
  -z "Run cast call --rpc-url \$BASE_SEPOLIA_RPC_URL 0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34 \"getStatus(uint256)(uint8)\" 16. Tell me which status (0=Pending, 1=Revealed, 2=Violated, 3=Expired)." \
  --provider anthropic -m claude-haiku-4-5
```

Expected output ends with the agent's interpretation of the cast call,
e.g. `Status Found: 0 = Pending`. Confirmed working against
commitment id 16 (the Trading-API-bound commitment from
`scripts/phase8-tradingapi-demo.ts`).
