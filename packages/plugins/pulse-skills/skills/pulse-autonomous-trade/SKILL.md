---
name: pulse-autonomous-trade
description: "Autonomous Pulse-bound trade end-to-end: 0G sealed reasoning → Pulse.commit → wait executeAfter → atomic-reveal swap through PulseGatedHook on the v4 pool. Use when the user gives a trading objective in natural language (e.g. 'sell 0.01 pETH for at least 1800 pUSD' or 'rebalance to 60/40'). The keystone skill that ties the rest together."
version: 1.0.0
author: Pulse
license: MIT
metadata:
  hermes:
    tags: [Pulse, Trading, Uniswap-v4, ERC-8004, Eth-Sepolia, autonomous-agents]
    related_skills: [pulse-commit, pulse-reveal, pulse-gated-swap, pulse-status-check, sealed-inference-with-pulse]
    requires_tools: [terminal]
---

# Pulse Autonomous Trade

End-to-end autonomous trading on Eth Sepolia, fully bound by `Pulse.sol` and gated by `PulseGatedHook`. Every trade goes through the canonical commit → reveal → execute cycle.

## When to use

Whenever the user gives a trading objective in natural language and expects me to actually move funds:

- "sell 0.01 pETH for at least 1800 pUSD"
- "rebalance my portfolio toward pUSD"
- "buy pETH if price holds above 2000"

If the user only asks to *inspect* commitments or query state, prefer `pulse-status-check`. If they want sealed reasoning anchored on-chain *without* a swap, prefer `sealed-inference-with-pulse`. This skill is the one that actually trades.

## Procedure

The heavy lifting (signing, hashing, RPC calls) is in `scripts/autonomous-trade.ts`. I orchestrate it via the `terminal` tool, then narrate the result.

### 1. Parse the user objective

Extract these from the message:

| Field | Example | Notes |
|---|---|---|
| `direction` | `sell` or `buy` | Required |
| `baseAmount` | `0.01` (as decimal) | Amount of `pETH` involved |
| `minPrice` | `1800` | Optional — slippage floor in pUSD per pETH |
| `executeAfterSec` | `30` | Optional — defaults to 30s |
| `revealWindowSec` | `600` | Optional — defaults to 600s (10 min) |

If the objective is too vague to parse (e.g. "do something smart"), use the `clarify` tool to ask the user for missing pieces. Don't guess.

### 2. Run the autonomous trade

```bash
bun run scripts/autonomous-trade.ts \
  --direction sell \
  --base-amount 0.01 \
  --min-price 1800 \
  --execute-after 30 \
  --reveal-window 600
```

The script:

1. Pulls a TEE-attested reasoning blob from 0G Compute (`qwen-2.5-7b-instruct`).
2. Hashes the (prompt, response, model) tuple → `reasoningCID`.
3. Computes `intentHash = keccak256(nonce ‖ abi.encode(PoolKey, SwapParams))`.
4. Submits `Pulse.commit(...)` with the intent hash, reasoning CID, executeAfter, revealWindow, signer provider, and a sealed signature from the TEE signer.
5. Waits until `executeAfter` passes on chain time.
6. Submits the swap to the v4 pool with `hookData = abi.encode(commitmentId, nonce)`. The hook calls `Pulse.reveal` atomically inside `beforeSwap`.
7. Reads back the final commitment status.

It prints progress to stderr and emits a single JSON object on stdout when done:

```json
{
  "status": "Revealed",
  "commitmentId": "9",
  "commitTx": "0xabc...",
  "swapTx": "0xdef...",
  "intentHash": "0x...",
  "reasoningCID": "0x...",
  "executeAfter": 1777458000,
  "revealedAtSec": 1777458035,
  "agentId": "3906",
  "ensName": "pulseagent.eth",
  "reasoningSummary": "first ~120 words of the 0G TEE response"
}
```

If anything fails on-chain, the JSON contains a `"error"` field instead and exit code is non-zero.

### 3. Report to the user

Format the output as a narrated multi-step Telegram message. Use markdown for tx-hash links so they're tappable. Surface every artifact:

```
🤖 Reasoning sealed via 0G TEE (qwen-2.5-7b)
   reasoningCID: 0x...

🔒 Committed cid=9
   tx: https://sepolia.etherscan.io/tx/0xabc...

⏳ Waiting 30s for executeAfter window...

🔓 Swapped + revealed atomically
   tx: https://sepolia.etherscan.io/tx/0xdef...

✅ Status: Revealed (+100 ERC-8004 reputation)
   pulseagent.eth · ERC-8004 #3906
```

The user should be able to click any tx hash and see the on-chain artifact. Don't paraphrase — quote tx hashes verbatim.

### 4. Memory

After a successful trade, write a memory entry:

```
trade {commitmentId}: direction={direction} base={baseAmount} min={minPrice} status=Revealed tx={swapTx}
```

So next session I can recall my recent trade history without re-querying chain.

## Pitfalls

- **Underestimated gas** — `Pulse.reveal` calls `ReputationRegistry.giveFeedback` through a `try/catch`. RPCs estimate the OOG-success branch and quote ~225k. The script ships with `gas: 1_200_000n` for the swap tx. Don't lower it.
- **Public Sepolia RPCs reject parallel sends** — the script serializes mint/approve/commit/swap calls. If you split this manually, do the same.
- **executeAfter must pass chain time, not wall-clock** — the script polls `eth_getBlockByNumber('latest')` and waits for `block.timestamp > executeAfter`. Sepolia block time is ~12s.
- **Drift attempts** — if the user follows up with "actually execute a different swap," see the `Drift` section below. Don't silently re-commit.

## Drift (force-drift demo)

If the user asks me to drift mid-flight ("actually sell at 100 instead of 1800"), I do not silently re-commit. I run `scripts/force-drift.ts` which:

1. Submits a swap with mismatched intent against the still-Pending commitment.
2. The hook reverts before any state change. Status stays Pending.
3. Calls `Pulse.reveal` directly with the (drifted) action data → status flips to **Violated**, ERC-8004 reputation `-1000`.

I narrate every step. The drift attempt is the demo killshot — it shows the audit perimeter is real.

```bash
bun run scripts/force-drift.ts --commitment-id 9
```

## Verification

After execution, confirm with:

```bash
bun run scripts/pulse-status.ts {commitmentId}
```

Expected `status=1 (Revealed)` for a kept commitment, `status=2 (Violated)` for a slashed one.
