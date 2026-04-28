# Pulse

> Galaxy-brain-resistant agent commitments. The first onchain primitive where an autonomous AI agent literally cannot change its mind after the market moves.

## What it is

`Pulse.sol` is a Solidity contract where AI agents:

1. **Commit** to a hashed action with sealed-inference reasoning at time `T`
2. **Reveal** the matching action between `T+executeAfter` and `T+revealDeadline`
3. Either get **rewarded reputation** (kept), **penalized** (mismatched reveal = violated), or **expired** (no reveal)

Reasoning is signed by a TEE provider via standard EIP-191 `personal_sign`. The signature is verified onchain via OpenZeppelin's `SignatureChecker` (handles both EOA and ERC-1271 signers). Reputation flows through the canonical ERC-8004 `ReputationRegistry`.

`markExpired(id)` is permissionless and can be triggered by anyone after `revealDeadline` — an offchain scheduler, the principal, or any concerned third party. Pulse does not bake in or favor any specific scheduler.

## Why

> "Decision-makers should commit to decision rules BEFORE knowing which outcome benefits them." — Vitalik Buterin, *Galaxy Brain Resistance* (Nov 2025)

Autonomous agents act 24/7 without oversight. Without binding commitments, they are vulnerable to MEV searchers, social engineering, prompt injection mid-flight, and rationalization drift. Pulse makes the agent's pre-commitment cryptographically self-enforcing: **the model cannot retroactively rewrite its own reasoning after the market moves**, and any attempt to do so is detectable, on-chain, and reputation-damaging.

## Dependencies

- **OpenZeppelin Contracts v5.1+** — `SignatureChecker`, `MessageHashUtils`, `ReentrancyGuard`
- **ERC-8004 IdentityRegistry + ReputationRegistry** — canonical deployments. Pulse does not redeploy them.
  - Base Sepolia / Ethereum Sepolia IdentityRegistry: `0x8004A818BFB912233c491871b3d84c89A494BD9e`
  - Base Sepolia / Ethereum Sepolia ReputationRegistry: `0x8004B663056A597Dffe9eCcC1965A193B7388713`
  - Reference implementation: [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts)

## Quick start

```bash
forge install
forge build
forge test
```

Deploy to Base Sepolia:

```bash
export PRIVATE_KEY=0x...
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
```

Override the registry defaults via `IDENTITY_REGISTRY` and `REPUTATION_REGISTRY` env vars.

## Architecture

```
Agent reads context (markets, news, onchain state)
        │
        ▼
Sealed inference (TEE-attested) — agent reasons on context
        │
        ▼ provider TEE signs (EIP-191 personal_sign over
        │   keccak256(agentId || intentHash || reasoningCID || executeAfter))
        ▼
Pulse.commit(...) — onchain commitment locked
        │
        ▼ (offchain: any scheduler queues a markExpired call at T+revealDeadline)
        ▼
[ T+executeAfter, T+revealDeadline ) — reveal window
        │
        ├─ Pulse.reveal(id, nonce, actionData)
        │     ├─ keccak256(nonce || actionData) == intentHash → Status.Revealed
        │     │        + ReputationRegistry.giveFeedback(+100, "kept")
        │     └─ mismatch → Status.Violated + giveFeedback(-1000, "violated")
        │
        └─ no reveal by deadline → markExpired() callable by anyone
              → Status.Expired + giveFeedback(-500, "expired")
```

## Repository layout

```
contracts/
├── Pulse.sol                       # main contract
├── interfaces/                     # subsets of canonical ERC-8004 ABIs
└── mocks/                          # used in tests only
script/
└── Deploy.s.sol
test/
└── Pulse.t.sol                     # commit + reveal-match + reveal-mismatch + expire + reverts
packages/
├── sdk/                            # @pulse/sdk — TypeScript client
└── agent/                          # reference agent that uses Pulse
```

## Status

Initial scaffold. Foundry tests green for: commit + reveal-match + reveal-mismatch + reveal-too-early + expire + wrong-signer-reverts + non-owner-reverts.

## License

MIT.
