---
name: pulse-status-check
description: 'Read a Pulse commitment status (Pending / Revealed / Violated / Expired) plus its window before deciding to reveal, swap, expire, or slash. Use as a precondition step in any agent workflow that interacts with a previously-committed Pulse intent.'
allowed-tools: Read, Bash, Grep, Glob
license: MIT
metadata:
  author: pulse
  version: '0.2.0'
---

# pulse-status-check

Cheap, view-only check on commitment state. Use this before every revealing,
swapping, or markExpired call so the agent doesn't burn gas on a transaction
that will revert.

## When to use

- Before any `pulse-reveal` call — so you know the window is open and the
  commitment is still `Pending`.
- Before submitting a `pulse-gated-swap` — to confirm the commitment exists
  and isn't already `Violated` / `Expired` (the hook will revert otherwise).
- Periodically by an off-chain watcher — to call `markExpired` on commitments
  that drifted past `revealDeadline` and harvest the rep-slash event for
  reputation analytics.

## Status values

| Value | Name      | Meaning                                                              |
| ----- | --------- | -------------------------------------------------------------------- |
| 0     | Pending   | Active commitment; reveal window may or may not be open              |
| 1     | Revealed  | Successfully closed with matching actionData (`+100` rep)            |
| 2     | Violated  | Closed with mismatched actionData (`-1000` rep)                      |
| 3     | Expired   | Window passed without a reveal; `markExpired` was called (`-500` rep) |

## Steps

### 1. Read the status enum

```ts
const status = await client.readContract({
  address: PULSE_ADDRESS,
  abi: PULSE_ABI,
  functionName: "getStatus",
  args: [commitmentId]
});
```

This is the cheapest call — a single `view` returning a `uint8`.

### 2. Read the full commitment when you need timing

```ts
const c = await client.readContract({
  address: PULSE_ADDRESS,
  abi: PULSE_ABI,
  functionName: "getCommitment",
  args: [commitmentId]
});

// c = {
//   agentId, principal, commitTime, executeAfter, revealDeadline,
//   status, intentHash, reasoningCID, signerProvider
// }
```

Use `c.executeAfter` and `c.revealDeadline` to drive scheduler logic:

```ts
const now = BigInt(Math.floor(Date.now() / 1000));
const inWindow = now >= c.executeAfter && now < c.revealDeadline;
const expired = now >= c.revealDeadline && c.status === 0; // Pending past deadline
```

### 3. Branch agent behavior

```ts
switch (status) {
  case 0: // Pending
    if (now < c.executeAfter) return "wait";
    if (now >= c.revealDeadline) return "expire-it";
    return "reveal-or-swap";
  case 1: return "kept-already";
  case 2: return "violated-already";
  case 3: return "expired-already";
}
```

### 4. (Optional) Watch events instead of polling

The contract emits `Committed`, `Revealed`, `Violated`, `Expired`. Subscribe
via `watchContractEvent` if your agent runs as a long-lived process — cheaper
than polling `getStatus` every block.

```ts
client.watchContractEvent({
  address: PULSE_ADDRESS,
  abi: PULSE_ABI,
  eventName: "Revealed",
  onLogs: (logs) => { /* handle */ }
});
```

## Edge cases

- **`principal == address(0)`** means the commitment id was never minted.
  `getCommitment` returns the zero-struct rather than reverting; check the
  principal field before treating data as authoritative.
- **`status == Pending` past `revealDeadline`** is the trigger for
  `markExpired`. Anyone can call it (no auth required) — typically a watcher
  or a counterparty.
- **Reading `intentHash` does *not* reveal `actionData`.** The hash is
  one-way. Until reveal, `actionData` is a private piece of state held by
  whoever has the nonce.

## Related skills

- `pulse-commit` — the upstream skill that creates the commitments this skill
  reads.
- `pulse-reveal` — the most common follow-up action when status is `Pending`
  inside the window.
- `pulse-gated-swap` — when the action is a v4 swap, check status before
  submitting through the hook to avoid `IntentMismatch` reverts.
