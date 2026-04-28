# Pulse

> Galaxy-brain-resistant agent commitments. The first onchain primitive where an autonomous AI agent literally cannot change its mind after the market moves — enforceable at the AMM layer.

## What it is

Two cooperating contracts:

**`Pulse.sol`** — the commitment primitive. AI agents:
1. **Commit** to a hashed action with sealed-inference reasoning at time `T`
2. **Reveal** the matching action between `T+executeAfter` and `T+revealDeadline`
3. Get **rewarded reputation** (kept), **penalized** (mismatched reveal = violated), or **expired** (no reveal)

**`PulseGatedHook.sol`** — a Uniswap v4 hook that turns a Pulse commitment into a swap permission. Pools deployed with this hook only execute swaps whose `(key, params)` hashes match a pending or revealed Pulse commitment in the open window. Without a matching commitment, the swap reverts.

Reasoning is signed by a TEE provider via standard EIP-191 `personal_sign`. Onchain verification uses OpenZeppelin's `SignatureChecker` (handles both EOA and ERC-1271 signers). Reputation flows through the canonical ERC-8004 `ReputationRegistry`.

## Why

> "Decision-makers should commit to decision rules BEFORE knowing which outcome benefits them." — Vitalik Buterin, *Galaxy Brain Resistance* (Nov 2025)

Autonomous agents act 24/7 without oversight. Without binding commitments, they are vulnerable to MEV searchers, social engineering, prompt injection mid-flight, and rationalization drift. Pulse makes the agent's pre-commitment cryptographically self-enforcing: **the model cannot retroactively rewrite its own reasoning after the market moves**, and any attempt to do so is detectable, on-chain, and reputation-damaging. With `PulseGatedHook`, the binding is enforced at the swap layer — wrong-intent swaps don't just lose reputation, they don't execute at all.

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
        │  intentHash = keccak256(nonce || abi.encode(poolKey, swapParams))
        │
        ▼ (offchain: any scheduler queues a markExpired call at T+revealDeadline)
        ▼
[ T+executeAfter, T+revealDeadline ) — reveal window
        │
        ├─ Direct path: Pulse.reveal(id, nonce, actionData)
        │     ├─ keccak256(nonce || actionData) == intentHash → Status.Revealed
        │     │        + ReputationRegistry.giveFeedback(+100, "kept")
        │     └─ mismatch → Status.Violated + giveFeedback(-1000, "violated")
        │
        ├─ Hook-gated path: swapper submits to a v4 pool wired with PulseGatedHook
        │     hookData = abi.encode(commitmentId, nonce)
        │   PulseGatedHook.beforeSwap:
        │     ├─ commitment status Pending → atomically calls Pulse.reveal
        │     │       (kept → swap proceeds; mismatch → revert + state rolls back)
        │     └─ commitment status Revealed → verifies hash; allows swap
        │
        └─ no reveal by deadline → markExpired() callable by anyone
              → Status.Expired + giveFeedback(-500, "expired")
```

The hook makes Pulse load-bearing for swap *execution*, not just validation. A pool deployed with `PulseGatedHook` only accepts swaps backed by a Pulse commitment — agents cannot drift to a different action between the commit and the swap.

## Dependencies

- **OpenZeppelin Contracts v5.5+** — `SignatureChecker`, `MessageHashUtils`, `ReentrancyGuard` (consumed transitively through `OpenZeppelin/uniswap-hooks`)
- **OpenZeppelin/uniswap-hooks** — production-grade `BaseHook` for v4 hook implementations
- **Uniswap v4-core + v4-periphery** — `IPoolManager`, `Hooks`, `IHooks`, `BeforeSwapDelta`, `HookMiner` (transitively through `OpenZeppelin/uniswap-hooks`)
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

Should report **17 tests passing** (6 Pulse + 11 hook).

Deploy Pulse to Base Sepolia:

```bash
export PRIVATE_KEY=0x...
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
```

Deploy `PulseGatedHook` against a v4 PoolManager:

```bash
export POOL_MANAGER=0x...        # v4 PoolManager on the target chain
export PULSE=0x...               # the Pulse address from the previous step
forge script script/DeployHook.s.sol --rpc-url base_sepolia --broadcast
```

The deploy script CREATE2-mines a salt that produces a hook address with the required `BEFORE_SWAP_FLAG` bits in its lower 14 bits. Override the registry defaults via `IDENTITY_REGISTRY` / `REPUTATION_REGISTRY` env vars for other chains.

## Repository layout

```
contracts/
├── Pulse.sol                       # commitment primitive
├── hooks/
│   └── PulseGatedHook.sol          # v4 hook gating swaps by Pulse commitments
├── interfaces/                     # subsets of canonical ERC-8004 ABIs
└── mocks/                          # used in tests only
script/
├── Deploy.s.sol                    # deploys Pulse against canonical registries
└── DeployHook.s.sol                # CREATE2-mines a salt + deploys the hook
test/
├── Pulse.t.sol                     # 6 tests on the commitment primitive
└── PulseGatedHook.t.sol            # 11 tests on the v4 hook layer
packages/
├── sdk/                            # @pulse/sdk — TypeScript client + intent/hookData helpers
└── agent/                          # reference agent that uses Pulse
.claude/
└── skills/                         # agent skills (Uniswap, OZ, Pashov, ethskills, 0g-compute)
```

## Skills

This repo includes the `Uniswap/uniswap-ai` skills and the OpenZeppelin
`uniswap-hooks` library — the v4 hook here was built using their
`v4-hook-generator` decision table and audited against the
`v4-security-foundations` checklist before commit. See `CLAUDE.md` for the
full skill index and which skill applies to which task.

## Status

Initial scaffold complete. Tests: 17 passing
- Pulse: commit, reveal-match, reveal-mismatch, reveal-too-early, expire,
  wrong-signer, non-owner reverts
- PulseGatedHook: atomic-reveal swap, separate-reveal swap, missing
  commitment, mismatched intent, pre-window, post-deadline, malformed
  hookData, expired status, separate-mismatch-locks-Violated, double-spend
  edge case

## License

MIT.
