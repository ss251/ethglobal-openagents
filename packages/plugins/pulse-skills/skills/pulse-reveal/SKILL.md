---
name: pulse-reveal
description: 'Reveal a Pulse commitment by submitting matching nonce + actionData inside the [executeAfter, revealDeadline) window. Use when an autonomous agent that previously committed to an action needs to fulfil that commitment, or when you deliberately want to lock in the Violated state to slash the agent reputation.'
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
license: MIT
metadata:
  author: pulse
  version: '0.2.0'
---

# pulse-reveal

Close a Pulse commitment. Submit `(commitmentId, nonce, actionData)` and the
contract checks `keccak256(abi.encodePacked(nonce, actionData)) == intentHash`.

- Match → status `Revealed`, `+100` reputation via ERC-8004 `giveFeedback("kept")`.
- Mismatch → status `Violated`, `-1000` reputation via `giveFeedback("violated")`,
  no execution downstream.
- Outside the window → revert (`TooEarly` or `TooLate`).

## When to use this skill

- The agent's primary path: it committed at T, and at T+executeAfter it needs
  to actually execute. Reveal before executing the off-chain leg.
- The accountability path: someone (the principal, a watcher, an opposing
  party) wants to *prove* a commitment was broken. Submit the off-by-one
  `actionData` directly to lock in `Violated`. See "Violated lock-in" below.

If you're also using `pulse-gated-swap`, the hook calls `Pulse.reveal`
atomically inside `beforeSwap` — you don't reveal separately.

## Decision checklist

1. **`block.timestamp >= executeAfter`.** Earlier reverts as `TooEarly`.
   Use `pulse-status-check` to confirm window is open.
2. **`block.timestamp < revealDeadline`.** Past the deadline reverts as
   `TooLate`. After deadline, anyone (including a third party) can call
   `markExpired` to slash with `-500` reputation.
3. **`(nonce, actionData)` are byte-identical to commit time.** A single
   different byte means `Violated`. If you're using @pulse/sdk's
   `encodeSwapAction`, recompute it with the *same* `(poolKey, swapParams)` —
   sorted currencies and integer fee/tickSpacing match exactly.
4. **`actionData` is whatever downstream code consumes.** Pulse doesn't
   interpret it. The reveal call only stores it via the `Revealed` event for
   later off-chain verification.

## Steps

### 1. Read commitment state

```ts
import {readContract} from "viem/actions";

const status = await client.readContract({
  address: PULSE_ADDRESS,
  abi: PULSE_ABI,
  functionName: "getStatus",
  args: [commitmentId]
});

// 0 = Pending, 1 = Revealed, 2 = Violated, 3 = Expired
if (status !== 0) throw new Error("commitment already finalized");

const c = await client.readContract({
  address: PULSE_ADDRESS,
  abi: PULSE_ABI,
  functionName: "getCommitment",
  args: [commitmentId]
});

const now = BigInt(Math.floor(Date.now() / 1000));
if (now < c.executeAfter) throw new Error("too early");
if (now >= c.revealDeadline) throw new Error("expired window — call markExpired instead");
```

### 2. Submit the reveal

Via `@pulse/sdk`:

```ts
import {revealIntent} from "@pulse/sdk";

const txHash = await revealIntent(wallet, PULSE_ADDRESS, {
  commitmentId,
  nonce,
  actionData
});
```

Via raw viem:

```ts
const txHash = await wallet.writeContract({
  address: PULSE_ADDRESS,
  abi: PULSE_ABI,
  functionName: "reveal",
  args: [commitmentId, nonce, actionData]
});
```

### 3. Verify outcome

The receipt emits exactly one of `Revealed(id, agentId, actionData)` or
`Violated(id, agentId, computedHash)`. Decode it and feed the result back to
the agent's higher-level orchestrator.

```ts
import {decodeEventLog} from "viem";

const receipt = await client.waitForTransactionReceipt({hash: txHash});
for (const log of receipt.logs) {
  try {
    const ev = decodeEventLog({abi: PULSE_ABI, data: log.data, topics: log.topics});
    if (ev.eventName === "Revealed") return "kept";
    if (ev.eventName === "Violated") return "broken";
  } catch {}
}
```

## Front-running concerns

The moment your `actionData` enters the public mempool, MEV bots see what the
agent is about to do. If the downstream action is a swap, sandwiching is
trivial. Mitigations:

- **Use a private mempool** for the reveal transaction (Flashbots Protect, MEV
  Blocker, sequencer-private channels on L2s).
- **Bundle reveal + downstream action** atomically. If the action is a v4
  swap, use `pulse-gated-swap` so reveal happens *inside* `beforeSwap` and
  there is no public mempool window.
- **Tighten `revealWindow`** so the attack window is short.

## Violated lock-in

Atomic-reveal-via-hook has an interesting property: when the hook reverts on
intent mismatch, Pulse's transition to `Violated` rolls back too — so the rep
slash doesn't actually persist. To *guarantee* the slash, the principal calls
`Pulse.reveal` directly with the mismatched `actionData`. The mismatch
transitions status to `Violated`, the call returns `false` instead of
reverting, and the rep slash sticks.

Use this path when:

- A watcher is trying to prove the agent went off-script.
- An opposing party in a multi-agent commitment wants to penalize their
  counterparty.
- The agent's owner wants to deliberately retire a commitment as broken
  (e.g. a meta-decision made it unsafe to execute).

## Failure modes

| Revert reason | Cause                                                            |
| ------------- | ---------------------------------------------------------------- |
| `TooEarly`    | `block.timestamp < executeAfter`                                 |
| `TooLate`     | `block.timestamp >= revealDeadline`                              |
| `BadStatus`   | commitment is not `Pending` (already revealed, violated, expired) |

## Related skills

- `pulse-commit` — pair with this; commit-reveal is the core flow.
- `pulse-status-check` — read state before reveal to avoid wasted gas.
- `pulse-gated-swap` — alternative to direct reveal for v4 swaps.
