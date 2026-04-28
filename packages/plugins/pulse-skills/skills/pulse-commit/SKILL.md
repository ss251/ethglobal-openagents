---
name: pulse-commit
description: 'Make a Pulse commitment — bind an autonomous agent to a hashed action plus sealed-inference reasoning at time T. Use whenever an agent decides on a future action (swap, transfer, vote, signal) and you need that decision to be cryptographically un-changeable, mid-flight-prompt-injection-proof, and reputation-staked via ERC-8004.'
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
license: MIT
metadata:
  author: pulse
  version: '0.2.0'
---

# pulse-commit

Cryptographically lock an agent's decision *before* the market knows about it. The
agent commits to `keccak256(nonce || actionData)` plus a TEE-signed reasoning
hash, and gets a finite reveal window in which it can prove it kept the decision.
Outside that window, or with a mismatched reveal, the agent's ERC-8004 reputation
is slashed.

This skill is **agent-framework-agnostic**. It works for OpenClaw, Hermes,
ElizaOS, Eliza, LangChain, custom Anthropic-API agents, or any code that can
call viem / ethers / web3.py.

## When to use this skill

Use this skill when:

- An autonomous agent has just **made a decision** (e.g. "sell ETH if vol > X",
  "vote yes on proposal 42", "rebalance to 60/40 at 4pm UTC").
- The decision is **non-trivial to reverse** if mid-flight conditions change
  the agent's mind in a way you do not trust (prompt injection, social
  engineering, rationalization drift, MEV reaction).
- You want the decision to **carry economic weight** — kept commitments earn
  reputation via the canonical ERC-8004 ReputationRegistry; broken ones get
  slashed. Pools wired with `PulseGatedHook` simply refuse swaps that don't
  match a pending Pulse commitment.

Don't use it for ephemeral chain reads, view calls, or actions the agent should
genuinely be free to revisit per-tick.

## What you commit to

- `agentId` — ERC-8004 IdentityRegistry token id you control (`isAuthorizedOrOwner`)
- `intentHash` — `keccak256(abi.encodePacked(nonce, actionData))`. The
  `actionData` encoding is application-specific. For Uniswap v4 swap intents,
  use `actionData = abi.encode(PoolKey, SwapParams)` so a `PulseGatedHook` can
  reproduce the hash in `beforeSwap`.
- `reasoningCID` — content-addressed pointer to the agent's reasoning
  (e.g. 0G Storage CID, IPFS, Arweave). Resolved off-chain at audit time.
- `executeAfter` / `revealWindow` — defines the `[T+executeAfter, T+executeAfter+revealWindow)`
  window in which `reveal` is callable.
- `signerProvider` + `sealedSig` — EIP-191 `personal_sign` over
  `keccak256(abi.encode(agentId, intentHash, reasoningCID, executeAfter))`. For
  0G Compute, use the address surfaced by `acknowledgeProviderSigner`. The
  contract verifies via OpenZeppelin `SignatureChecker` so EOA + ERC-1271 both
  work.

## Decision checklist (run before commit)

1. **Have a real decision.** Don't commit to "I'll do something" — the action
   bytes must already be final.
2. **Set `executeAfter` >= `block.timestamp + safetyMargin`.** Implementations
   should reject `commit` calls whose `executeAfter` is in the past.
3. **Pick `revealWindow` deliberately.** Too short risks accidental expiry;
   too long lets the agent re-evaluate based on new info. 30–120 minutes is a
   sane default for swap intents on a ~12s block chain.
4. **Generate `nonce` from a CSPRNG.** `crypto.randomBytes(32)` /
   `secrets.token_bytes(32)`. Never derive it from public state — front-runners
   can predict the intent.
5. **Pull the sealed signature *after* the agent reasons.** The signature must
   be over the final `(agentId, intentHash, reasoningCID, executeAfter)` tuple.
   If the reasoning model changes its mind, the hash changes, the signature
   becomes invalid, and `commit` reverts.

## Steps

### 1. Build the action bytes

The encoding is application-specific. For Uniswap v4:

```ts
import {encodeAbiParameters} from "viem";

const actionData = encodeAbiParameters(
  [
    {type: "tuple", components: [
      {name: "currency0", type: "address"},
      {name: "currency1", type: "address"},
      {name: "fee", type: "uint24"},
      {name: "tickSpacing", type: "int24"},
      {name: "hooks", type: "address"}
    ]},
    {type: "tuple", components: [
      {name: "zeroForOne", type: "bool"},
      {name: "amountSpecified", type: "int256"},
      {name: "sqrtPriceLimitX96", type: "uint160"}
    ]}
  ],
  [poolKey, swapParams]
);
```

Or, when using `@pulse/sdk`:

```ts
import {encodeSwapAction, intentHashForSwap} from "@pulse/sdk";

const actionData = encodeSwapAction(poolKey, swapParams);
const intentHash = intentHashForSwap(nonce, poolKey, swapParams);
```

For non-swap actions (transfers, signed calls, governance votes), just
`abi.encode` whatever fields downstream code needs.

### 2. Pull TEE-signed reasoning

The provider's TEE signs the reasoning hash payload:
`keccak256(abi.encode(agentId, intentHash, reasoningCID, executeAfter))`.

For 0G Compute via the broker:

```ts
import {fetchSealedReasoning} from "@pulse/sdk";

const reasoning = await fetchSealedReasoning({
  brokerUrl: process.env.ZG_BROKER_URL!,
  chatId: chatIdFromInferenceCall,
  model: "deepseek-reasoner",
  signerAddress: process.env.ZG_SIGNER_ADDRESS! as `0x${string}`
});
```

For non-TEE providers, sign the same payload with any wallet whose address you
trust (an HSM, a multi-sig, an EOA reserved for this purpose). Pulse only
checks signature validity — *what* you trust about the signer is policy.

### 3. Call `Pulse.commit`

Via `@pulse/sdk`:

```ts
import {commitIntent} from "@pulse/sdk";

const txHash = await commitIntent(wallet, PULSE_ADDRESS, {
  agentId,
  actionData,
  nonce,
  reasoning,
  reasoningCID,
  executeAfter,
  revealWindow
});
```

The SDK rebuilds `intentHash` internally from `(nonce, actionData)` so callers
don't have to keep two versions in sync.

Via raw viem:

```ts
import {keccak256, encodePacked} from "viem";

const intentHash = keccak256(encodePacked(["bytes32", "bytes"], [nonce, actionData]));

await wallet.writeContract({
  address: PULSE_ADDRESS,
  abi: PULSE_ABI,
  functionName: "commit",
  args: [
    agentId,
    intentHash,
    reasoningCID,
    executeAfter,
    revealWindow,
    reasoning.signerAddress,
    reasoning.signature
  ]
});
```

### 4. Persist `(commitmentId, nonce, actionData)` locally

You will need all three at reveal time. The `commitmentId` is emitted as the
first indexed arg of the `Committed` event. Decode it from the receipt or
read the contract's auto-incremented counter.

**Treat `nonce` and `actionData` as commitment-local secrets until reveal.**
Anyone who learns them before `executeAfter` can front-run.

## Failure modes

| Revert reason         | Cause                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `NotAgentOwner`       | `msg.sender` is not authorized for `agentId` per ERC-8004 IdentityRegistry                    |
| `InvalidProviderSig`  | `sealedSig` doesn't recover to `signerProvider` over the canonical payload                    |
| `BadWindow`           | `executeAfter` < `block.timestamp` or `revealWindow == 0`                                     |

## Composability notes

- Pulse only validates the *commitment*. Execution is up to the agent's
  downstream code — unless you also use the `pulse-gated-swap` skill, in which
  case a Uniswap v4 pool refuses to settle the swap without a matching
  commitment.
- Multiple commitments per agent are fine. Each gets its own id.
- The `principal` recorded onchain is `msg.sender` at commit time, not the
  agent's owner. If the agent runs through a gateway / forwarder, make sure
  the right address is calling.

## Related skills

- `pulse-reveal` — close the commitment by revealing matching `actionData`.
- `pulse-status-check` — read commitment status before deciding what to do.
- `pulse-gated-swap` — execute a Uniswap v4 swap *through* a Pulse commitment.
- `sealed-inference-with-pulse` — get the TEE-signed reasoning that this skill
  consumes.
