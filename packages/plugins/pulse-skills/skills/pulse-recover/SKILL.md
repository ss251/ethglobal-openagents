---
name: pulse-recover
description: "Recover a Pulse commitment whose swap reverted. Use when an autonomous-trade run committed (cid is known, status=Pending, in reveal window) but the swap failed. Re-runs the gated swap against the existing commitment using the original nonce — no new commit, no drift, no reputation hit. The commitment stays bound; this just settles it."
allowed-tools: Read, Bash, Grep
license: MIT
metadata:
  author: pulse
  version: '0.3.0'
  hermes:
    tags: [Pulse, Recovery, Uniswap-v4, autonomous-agents]
    related_skills: [pulse-autonomous-trade, pulse-status-check, pulse-introspect]
    requires_tools: [terminal]
---

# pulse-recover

When `pulse-autonomous-trade` committed but the swap reverted (insufficient
balance, RPC hiccup, gas underestimation, etc.), the commitment is on-chain
in `Pending` state. The agent has a finite reveal window to settle it
correctly — anything else is drift.

This skill **does not change the intent**. It re-submits the same swap with
the same nonce so the hook validates `keccak256(nonce || actionData) ==
intentHash` and lets the trade through.

## When to use

- The previous `pulse-autonomous-trade` JSON contained `status:
  "SwapReverted"`. The structured `recovery.pulseRetryCmd` is your invocation.
- You have `commitmentId` and the original `nonce` from a prior run, the
  status is `Pending`, and `inRevealWindow=true`.

## When NOT to use

- The status is already `Revealed`, `Violated`, or `Expired` — nothing to
  recover.
- The reveal window is closed (`overdueExpired=true`) — the commitment needs
  `Pulse.markExpired(id)` instead. Use `pulse-status-check` to verify, then
  call markExpired directly (no reveal possible past the deadline).
- You don't have the original nonce — without it you cannot match the
  intentHash. Look at the prior run's stdout JSON or the
  `Committed` event topics.

## Procedure

```bash
bun run scripts/pulse-retry.ts \
  --commitment-id <id> \
  --nonce 0x<32-byte-nonce> \
  --action-data 0x<full-actionData-hex>     # optional but recommended
```

If `--action-data` is omitted, the script reconstructs it from
`--direction sell|buy --base-amount X` (must match the original commit).

The script:
1. Reads the on-chain commitment via `Pulse.getCommitment(id)`.
2. Verifies it's `Pending` and inside the reveal window. If not, returns a
   structured `Skipped` result with a reason.
3. Calls `ensureFundedAndApproved` (direction-aware — only mints/approves
   the token actually being sold).
4. Submits the gated swap with `hookData = abi.encode(commitmentId, nonce)`.
5. Reads the final status and emits a single JSON object with the swap tx,
   funding deltas, and explorer links.

## Example

The agent committed cid=11 with nonce `0xa8a3e3f9…`, the swap reverted at
~30k gas because pWETH balance was short.

```bash
bun run scripts/pulse-retry.ts \
  --commitment-id 11 \
  --nonce 0xa8a3e3f9c292da51f3e95651abef8594f9698fbf4bff06df9bcad116384322b7 \
  --direction sell \
  --base-amount 0.005
```

Returns:

```json
{
  "scenario": "pulse-retry",
  "status": "Success",
  "commitmentId": "11",
  "commitmentStatus": "Revealed",
  "swapTx": "0x…",
  "funding": {"minted": true, "approved": false, ...}
}
```

## Failure modes

| Symptom                              | Cause                              | Fix                                             |
| ------------------------------------ | ---------------------------------- | ----------------------------------------------- |
| `status: "Skipped" reason: terminal` | Commitment already settled         | Nothing to do                                    |
| `status: "Skipped" reason: overdue`  | Past `revealDeadline`              | Call `markExpired(id)` directly                  |
| Gas estimation reverts in retry      | Wrong action-data → intent mismatch | Re-derive action-data exactly from prior run    |
| Hook reverts with "agentId zero"     | Wrong agent ID committed           | Confirm `.env` AGENT_ID matches signer provider  |

Stay in the bind. If the original intent was wrong, the right move is to
let the commitment expire and slash the rep — not drift.
