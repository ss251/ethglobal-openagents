---
name: pulse-introspect
description: "Inspect recent agent wallet activity or a single Pulse commitment without writing your own block-scanner. Decodes the function selector + Pulse status for each tx so the agent can diagnose 'why did my swap revert?' or 'is this commitment still recoverable?' in one shot."
allowed-tools: Read, Bash, Grep
license: MIT
metadata:
  author: pulse
  version: '0.3.0'
  hermes:
    tags: [Pulse, Introspection, Diagnostics, autonomous-agents]
    related_skills: [pulse-status-check, pulse-recover, pulse-autonomous-trade]
    requires_tools: [terminal]
---

# pulse-introspect

Canonical introspection helper. Use this *before* you start writing inline
viem scripts to scan blocks. The agent ran into this exact failure mode in
the un-coached test — it spent a dozen iterations writing block-scan one-shots
when the right answer was always "use the helper."

## When to use

- A previous Pulse-bound script returned `status: "SwapReverted"` and you
  need to know what the failed transaction looked like (gas, function name,
  receipt status).
- The user asks "what did my agent do recently?" or "show my last 5 txs."
- You need a quick status snapshot of a specific Pulse commitment without
  writing a contract read inline.

## Two modes

### 1. Recent-activity scan (default)

```bash
bun run scripts/pulse-introspect.ts                 # last 20 blocks
bun run scripts/pulse-introspect.ts --last 50
bun run scripts/pulse-introspect.ts --from-block 10756500
```

Walks blocks from `--from-block` (or `latest - --last`) up to head, picks out
all transactions sent from the agent wallet, decodes the function selector
against the Pulse + ERC-20 + SwapTest router ABIs, and emits a JSON array.

### 2. Single-commitment inspect

```bash
bun run scripts/pulse-introspect.ts --commitment-id 11
```

Reads `Pulse.getCommitment(id)` and emits the full state — status, principal,
intentHash, reasoningCID, signerProvider, executeAfter, revealDeadline, and
the `inRevealWindow` / `overdueExpired` convenience flags.

## Output contract

Both modes write a single JSON object on stdout — BigInt-safe, never breaks
on uint256 fields. Stderr carries scan progress (block ranges, target wallet)
so you can narrate while it runs.

## Example

After an `autonomous-trade.ts` run reverted, the agent should:

```bash
# 1. Was it the swap or the commit that reverted?
bun run scripts/pulse-introspect.ts --last 20

# 2. Is the commitment still recoverable?
bun run scripts/pulse-introspect.ts --commitment-id 11
```

If the commitment is `Pending` and `inRevealWindow=true`, hand off to
`pulse-recover`. If `overdueExpired=true`, surface that to the user — the
window is gone, accept the slash and move on.
