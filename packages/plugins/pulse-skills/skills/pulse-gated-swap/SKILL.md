---
name: pulse-gated-swap
description: 'Execute a Uniswap v4 swap through a PulseGatedHook so the swap only settles if a matching Pulse commitment exists in the open window. Use whenever an autonomous agent should be physically unable to swap through a different action than the one it pre-committed to.'
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
license: MIT
metadata:
  author: pulse
  version: '0.2.0'
---

# pulse-gated-swap

Move enforcement from "rep-only" to "rep + execution". A v4 pool deployed with
`PulseGatedHook` only accepts swaps whose `(PoolKey, SwapParams)` hashes match
a `Pending` or `Revealed` Pulse commitment in `[executeAfter, revealDeadline)`.
Wrong-intent swaps don't just lose reputation — they don't happen.

## When to use this skill

- The committed action is a Uniswap v4 swap (most common autonomous-agent
  action that benefits from binding).
- You want a single tx for both reveal and execution — the hook calls
  `Pulse.reveal` atomically inside `beforeSwap`.
- You want to eliminate the public-mempool reveal window so MEV searchers
  can't observe the intent before it executes.

If the action isn't a swap (transfer, vote, signed message), use plain
`pulse-reveal` instead and execute downstream code yourself.

## How it works

```
┌──────────┐       ┌────────────┐       ┌────────────────┐
│ swapper  │──swap─►   v4 Pool   ├──hookData──► PulseGatedHook │
└──────────┘       └────────────┘                  │
                                                   │
                                  Pulse.getCommitment(id)
                                                   │
                                  status==Pending? ─────► Pulse.reveal(id, nonce, abi.encode(key, params))
                                  status==Revealed? ────► verify hash, allow swap
                                  status==Violated|Expired? ──► revert
```

`hookData = abi.encode(uint256 commitmentId, bytes32 nonce)` — the swapper
attaches it to the v4 swap call. The hook decodes, looks up the commitment,
and either atomically reveals it or hash-verifies an already-revealed one.

## Encoding contract (must match exactly)

`actionData = abi.encode(PoolKey, SwapParams)` — same encoding used at
`Pulse.commit` time and recomputed inside `beforeSwap`. The intent hash is
`keccak256(abi.encodePacked(nonce, abi.encode(key, params)))`.

If the swapper passes a `(key, params)` that differs from the committed one
by even one byte, the hook reverts with `IntentMismatch`. **No silent
mismatches** — the swap dies on the spot.

## Steps

### 1. Make the commitment

Use the `pulse-commit` skill. The committed `actionData` MUST be
`abi.encode(poolKey, swapParams)` — for a Uniswap v4 swap intent, this is the
canonical encoding. Use `@pulse/sdk`:

```ts
import {encodeSwapAction, intentHashForSwap} from "@pulse/sdk";

const actionData = encodeSwapAction(poolKey, swapParams);
const intentHash = intentHashForSwap(nonce, poolKey, swapParams);
```

### 2. Wait for the window

Don't try to swap before `executeAfter` — the hook reverts via
`Pulse.reveal`'s `TooEarly`. Use `pulse-status-check` if you need to
poll.

### 3. Build hookData

```ts
import {encodeHookData} from "@pulse/sdk";

const hookData = encodeHookData(commitmentId, nonce);
```

Or raw viem:

```ts
import {encodeAbiParameters} from "viem";

const hookData = encodeAbiParameters(
  [{type: "uint256"}, {type: "bytes32"}],
  [commitmentId, nonce]
);
```

### 4. Submit the swap

Submit via PoolSwapTest, the v4 SwapRouter, the Universal Router, or any v4
swap entry. The pool's `key.hooks` must be the `PulseGatedHook` deployment.
`hookData` is the last argument.

```ts
// PoolSwapTest pattern (the simplest direct route, used in our integration tests)
await wallet.writeContract({
  address: SWAP_ROUTER,
  abi: SWAP_ROUTER_ABI,
  functionName: "swap",
  args: [
    poolKey,
    swapParams,
    {takeClaims: false, settleUsingBurn: false},
    hookData
  ]
});
```

For Universal Router or smart-routing flows, refer to
[Uniswap v4 quickstart](https://docs.uniswap.org/contracts/v4/quickstart/swap)
— the hookData passing pattern is identical, only the entry point changes.

### 5. Decode the outcome

Inspect logs from the receipt. You'll see one of:

- `Revealed(id, agentId, actionData)` from Pulse — the atomic-reveal path
  succeeded and the swap executed.
- A revert with selector `IntentMismatch()` (atomic mismatch) or `BadStatus()`
  (commitment was already Violated/Expired) or pool-side errors.

## Atomic-reveal rollback gotcha

When the hook reverts on `IntentMismatch`, **Pulse's transition to
`Violated` rolls back too**. The agent's reputation is *not* slashed in that
case — the entire transaction undoes.

If you need the slash to land for a deliberate-violation flow:

1. Don't go through the hook with mismatched data.
2. Instead, call `Pulse.reveal(id, nonce, badActionData)` directly via
   `pulse-reveal`. The mismatch returns `false` (no revert), status flips to
   `Violated`, and `giveFeedback("violated")` fires.

## Pool deployment requirements

The pool's hook field must match a deployed `PulseGatedHook`. The hook
address is CREATE2-mined so its lower 14 bits encode the
`BEFORE_SWAP_FLAG` and only that flag — no `beforeSwapReturnDelta` (NoOp
attack vector closed by design). See `script/DeployHook.s.sol` in the
reference repo for the mining pattern.

When initializing a pool with this hook, pass `hooks = address(pulseGatedHook)`
in `PoolKey`. Liquidity providers don't need to know about Pulse — only
swappers.

## Failure modes

| Revert            | Cause                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| `MalformedHookData` | `hookData` shorter than 64 bytes or `commitmentId == 0`                |
| `BadStatus`       | commitment is `Violated` or `Expired`                                    |
| `IntentMismatch`  | atomic reveal failed, or post-reveal hash check failed                   |
| `TooEarly` / `TooLate` (from Pulse.reveal) | window closed                                                |

## Related skills

- `pulse-commit` — must precede every gated swap.
- `pulse-status-check` — verify status before submitting to the hook.
- `pulse-reveal` — needed only when you want a non-swap reveal, or want to
  lock in `Violated` deliberately.
- `sealed-inference-with-pulse` — gives you the TEE-signed reasoning bound
  to the swap intent before commit.
