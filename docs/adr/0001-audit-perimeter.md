# ADR-0001 · Extending the audit perimeter to agent reasoning

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-04-29 |
| Authors | Pulse Protocol team |
| Deciders | Pulse Protocol team |
| Tags | architecture · threat-model · v4-hook · 0G · ERC-8004 |

## Context

On April 18, 2026, KelpDAO and Aave lost **$292M**. The smart contracts
were fine. No bug, no broken logic. The vulnerability was a single
off-chain configuration decision — outside the perimeter every audit had
ever covered. OpenZeppelin's postmortem named the gap:

> *Code risk and operational risk are not the same problem.*
> ([Lessons From the KelpDAO Hack](https://www.openzeppelin.com/news/lessons-from-kelpdao-hack))

As protocols deepen integrations with off-chain infrastructure, the
operational surface grows faster than the auditable code surface. **Autonomous
AI agents are the next, sharpest expansion of that surface.**

The most consequential off-chain component in any agent-driven protocol is
the agent's *reasoning*. Audits never see it. A model can be injected,
drifted, or socially engineered, and the contract executes the resulting
action exactly as written. Reputation systems like ERC-8004 score the
*outcome* of an action — by the time slashing happens, the value is gone.

We need a primitive that pulls reasoning *into* the audit perimeter:
public, time-bounded, and economically slashable.

## Decision

Pulse extends the audit perimeter via a four-step lifecycle anchored on
ERC-8004 identity:

1. **Decide.** The agent assembles an action plan and calls a TEE-attested
   inference provider (0G's qwen-2.5-7b-instruct in our reference flow) to
   produce sealed reasoning + an EIP-191 signature over the canonical
   payload `keccak256(agentId, intentHash, reasoningCID, executeAfter)`.

2. **Commit.** The agent calls `Pulse.commit(...)` with the intent hash,
   reasoning CID, execute-after timestamp, reveal window, signer provider,
   and sealed sig. OpenZeppelin's `SignatureChecker` verifies — both EOAs
   (TEE-attested or stand-in) and ERC-1271 contract signers work.

3. **Reveal or get slashed.** Inside `[executeAfter, executeAfter +
   revealWindow)`, the agent must reveal action data whose hash matches
   the commitment. Mismatch → status flips `Violated`, ERC-8004 reputation
   takes `-1000`. Past the window with no reveal → anyone can call
   `markExpired`, status flips `Expired`, reputation takes `-500`. Match →
   `Revealed`, reputation takes `+100`.

4. **(For v4 swaps) Make wrong-intent swaps physically impossible.**
   `PulseGatedHook` reads the swap's `hookData = abi.encode(commitmentId,
   nonce)` and either calls `Pulse.reveal` atomically or verifies a
   pre-existing reveal matches. Mismatch reverts the swap before any state
   change. The slash and the swap are bound by the same atomic transaction.

The protocol composes:

- **ERC-8004** is the canonical identity + reputation surface (we redeploy
  nothing — we use the deployed registries at `0x8004A8…BD9e` and
  `0x8004B6…8713`).
- **0G Compute** provides TEE attestation for the reasoning.
- **Uniswap v4** hooks provide the only place an enforcement mechanism can
  fire *inside* the swap call frame.
- **Hermes / OpenClaw / any agent framework** plugs in via the
  `pulse-skills` SKILL.md bundle. No framework lock-in.

## Trade-offs we hit during implementation

These are the three load-bearing decisions where we picked one path over
another. Each one is documented in code + threat model with the rationale.

### Trade-off 1 — Atomic-reveal rollback gap

**Problem.** When `PulseGatedHook._beforeSwap` detects an intent mismatch,
it calls `Pulse.reveal` (which marks the commitment `Violated`) and then
`revert IntentMismatch()`. The revert rolls back the *entire* tx —
including the `Violated` state transition. A malicious agent can repeatedly
attempt mismatched swaps with zero reputation cost: the hook reverts every
time, the would-be slash never persists.

**Options considered:**

| Option | Verdict |
| --- | --- |
| **A.** Don't revert on mismatch — let the swap go through with a NoOp delta. | ❌ violates v4 security: `beforeSwapReturnDelta=false` is a load-bearing permission flag. The hook holds **no NoOp surface** and never claims a swap. |
| **B.** Use `try/catch` inside the hook to absorb the revert and emit only the failure event. | ❌ same outcome — the catch is in the hook's frame; the swap still has to revert at the PoolManager level once `beforeSwap` returns the wrong selector. |
| **C.** Move the slash to a separate transaction triggered after the failed swap is observed. | ✅ chosen. |
| **D.** Add a "speculative-revert" beacon contract that records the slash before the revert. | ❌ tried in design review; relies on `STATICCALL` semantics that don't survive a revert. |

**Decision.** Ship `scripts/watch-and-slash.ts` — a long-running watcher
that subscribes to `PoolManager` swap calls, decodes failed-tx calldata to
extract `(commitmentId, nonce, params)`, and calls `Pulse.reveal` *directly*
(outside the hook flow) with the actual mismatched data. The hash check
fails, status flips to `Violated`, the `-1000` slash sticks because
there's no parent tx to roll back.

**Why we accept the consequence.** A non-watcher operator sees zero
slashing, but also gets zero successful malicious swaps — the value is
preserved either way. The slash is a reputational cost, not a value-leak
fix; deferring it to an off-chain watcher is acceptable. Demonstrated
end-to-end via `scripts/violation-and-rollback-demo.ts`.

**References:** `contracts/hooks/PulseGatedHook.sol:88`, `scripts/watch-and-slash.ts`,
README threat-model row 2.

### Trade-off 2 — Anthropic body-size gate on Claude Max OAuth

**Problem.** When wiring Hermes-as-agent-runtime to Anthropic via the
user's Claude Pro/Max OAuth credentials (per Hermes upstream's
[`providers.md`](https://hermes-agent.nousresearch.com/docs/integrations/providers)
and [`credential-pools.md`](https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-pools)),
the inference call returns:

```
{"type":"invalid_request_error",
 "message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."}
```

Even with **"Extra Usage" disabled** on the user's Anthropic account.

**Investigation.** Bisected the Hermes request body against the live
`api.anthropic.com/v1/messages` endpoint, holding everything else constant
except tool count. The 402 trigger is **per-request body size**:

| tools sent | body bytes | result |
| ---: | ---: | --- |
| 5 | 3,024 | ✓ subscription |
| 15 | 19,303 | ✓ subscription |
| 18 | 23,192 | ✓ subscription |
| **19** | **25,433** | **402 (extra usage)** |
| 27 (Hermes default) | 37,839 | 402 |

Threshold sits between **23 KB and 25 KB**. System prompt, model name,
beta headers, and `User-Agent` make no difference — only request size.

**Decision.** `hermes-sandbox/auth.sh` automatically `hermes tools disable`s
the heavy toolsets (web, browser, vision, image_gen, tts, session_search,
clarify, delegation, cronjob, messaging, code_execution, memory, todo) and
empties `SOUL.md`. Resulting bodies land ~22 KB — under the gate. Pulse
skills (`terminal`, `file`, `skills`) stay enabled.

**Consequences.**

- ✅ Subscription routing works without paying the metered "extra usage"
  pool.
- ⚠ Hermes ships with fewer tools by default in our sandbox. Operators
  needing the full toolset must add a separate Anthropic API key —
  `hermes auth add anthropic --type api-key sk-ant-api03-…` — which
  bypasses the OAuth body-size gate entirely. Documented in
  [`hermes-sandbox/AUTH_NOTES.md`](../../hermes-sandbox/AUTH_NOTES.md).
- ⚠ The threshold is undocumented Anthropic policy and could change.

**References:** `hermes-sandbox/auth.sh`, `hermes-sandbox/AUTH_NOTES.md`,
README "Hermes integration" table.

### Trade-off 3 — Gas budgeting for `Pulse.reveal` / `markExpired`

**Problem.** Both `Pulse.reveal` and `markExpired` invoke
`ReputationRegistry.giveFeedback` through a Solidity `try/catch` so a
buggy registry can never freeze the commitment lifecycle. But this gives
RPC `eth_estimateGas` a perverse choice: there are *two* paths through the
catch block — the OOG-success branch (catch swallows the inner OOG, outer
call returns) and the success-success branch (giveFeedback writes its
storage). Estimators pick the cheaper one (~225 K gas). The actual
write-success path needs ~450 K because `giveFeedback`'s storage layout
hits multiple cold SSTOREs (Feedback struct + dynamic strings + clients
array push + emit).

**Symptom.** Default `viem.sendTransaction` with auto-estimated gas →
inner `giveFeedback` runs out of gas inside the catch → status flips fine,
but `NewFeedback` event never emits → ERC-8004 reputation never moves on
chain.

**Options considered:**

| Option | Verdict |
| --- | --- |
| **A.** Drop the try/catch — let registry reverts roll back the whole reveal. | ❌ couples Pulse's correctness to the registry's. Unacceptable for ERC-8004 composability. |
| **B.** Send a fixed gas limit to the inner call (`gasleft() - X`). | ❌ still subject to estimator's outer budget. |
| **C.** Document a per-call gas requirement; ship explicit defaults in the SDK. | ✅ chosen. |
| **D.** Decompose `giveFeedback` calls into a separate post-reveal tx. | ❌ extra tx, worse UX, defeats the "atomic slash" property. |

**Decision.** The Pulse SDK exports gas constants (`packages/sdk/src/pulse.ts`):

```ts
export const DEFAULT_REVEAL_GAS       = 600_000n;
export const DEFAULT_MARK_EXPIRED_GAS = 500_000n;

export async function revealIntent(wallet, pulseAddress, input, opts: {gas?: bigint} = {}) {
    return wallet.sendTransaction({
        to: pulseAddress,
        data: encodeFunctionData({…}),
        gas: opts.gas ?? DEFAULT_REVEAL_GAS,
    });
}
```

The threat-model table in README documents the contract-level reasoning
so integrators don't paper-cut on this when they wire their own UI. v4
swap callers go through `PoolSwapTest` / `UniversalRouter`; both let the
caller bump gas explicitly, and `scripts/exercise-gated-swap.ts` sends
swap txs with `gas: 1_200_000n` to budget for the inner reveal.

**Consequences.**

- ✅ The reveal/markExpired path is robust against estimator surprises.
- ⚠ Integrators *must* use the SDK helpers or set their own gas budget;
  raw `eth_estimateGas` against `Pulse.reveal` produces a number that
  silently swallows the slash.

**References:** `packages/sdk/src/pulse.ts`, `contracts/Pulse.sol:166`,
README threat-model row 11, `scripts/e2e-commit-reveal.ts`.

## Consequences

### Positive

- ✅ Reasoning enters the audit perimeter — public, time-bounded, slashable.
- ✅ ERC-8004 reputation responds *before* market value is taken (slash
  fires inside the same tx as the swap, when the hook is in the loop).
- ✅ Composes with any agent framework via SKILL.md (Hermes, OpenClaw,
  Eliza, custom).
- ✅ Composes with the canonical ERC-8004 deployment — we redeploy nothing.
- ✅ Three load-bearing trade-offs are explicit, instrumented, and tested
  end-to-end on Eth Sepolia.

### Negative

- ⚠ Atomic-rollback recovery requires an off-chain watcher to be running.
- ⚠ Subscription-OAuth routing for inference is gated on request size and
  is undocumented Anthropic policy.
- ⚠ Estimator-gated gas budgets force SDK-side defaults; raw integrators
  can foot-gun.
- ⚠ Pulse is voluntary. The defense is downstream: as credit, yield, and
  task layers price ERC-8004 reputation, non-committing agents get worse
  terms over time. We don't fix this in v0.1.

## What we explicitly are NOT defending against in v0.1

| Attack | Status | Why |
| --- | --- | --- |
| Sybil / burner agents | Inherited ERC-8004 weakness | No proof-of-personhood in the standard. |
| Reputation farming via trivial commitments | Not defended | Future work: stake-weighted reputation. |
| Vague reasoning that covers any future action | Partial | Hash equality, not semantic specificity. Off-chain reviewer policy is the hand-off. |
| Selective reveal (commit to multiple, reveal favorable one) | Not defended | Each unrevealed commitment costs `-500`. Profitable only if reputation isn't economically priced. |
| Wash-trade reputation between same-owner agents | Inherited ERC-8004 weakness | |
| Honest-on-paper, malicious-in-practice business model | Not defended | Pulse certifies *consistency*, not *quality of intent*. |

These are itemized in the README threat-model table — the explicit
disclosure is itself the v0.1 commitment.

## References

- README threat-model table — full attack/defense matrix
- [`SPEC.md`](../../SPEC.md) — protocol specification
- [`hermes-sandbox/AUTH_NOTES.md`](../../hermes-sandbox/AUTH_NOTES.md) —
  Anthropic OAuth routing notes
- [`scripts/violation-and-rollback-demo.ts`](../../scripts/violation-and-rollback-demo.ts) —
  trade-off 1 demonstration
- [`scripts/e2e-commit-reveal.ts`](../../scripts/e2e-commit-reveal.ts) —
  trade-off 3 demonstration
- OpenZeppelin's KelpDAO postmortem —
  https://www.openzeppelin.com/news/lessons-from-kelpdao-hack
- ERC-8004 reference implementation — https://github.com/erc-8004/erc-8004-contracts
- Uniswap v4 hooks — https://docs.uniswap.org/contracts/v4/concepts/hooks
- 0G Compute SDK — https://docs.0g.ai/build-with-0g/compute-network/sdk
