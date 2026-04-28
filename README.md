# Pulse Protocol

**Sealed Agent Commitments — extending the audit perimeter to the agent's reasoning.**

On April 18, 2026, KelpDAO and Aave lost $292 million. The smart contracts
were fine. No bug, no broken logic. The vulnerability was a single off-chain
configuration decision — outside the perimeter every audit had ever covered.

OpenZeppelin's postmortem named the gap: *code risk and operational risk are
not the same problem.* As protocols deepen integrations with off-chain
infrastructure, the operational surface grows faster than the auditable code
surface. ([Lessons From the KelpDAO Hack](https://www.openzeppelin.com/news/lessons-from-kelpdao-hack))

**Autonomous AI agents widen this gap.** The most consequential off-chain
component in any agent-driven protocol is the agent's *reasoning* — and audits
never see it. A model can be injected, drifted, or socially engineered, and
the contract executes the resulting action exactly as written.

## What Pulse does

Pulse extends the audit perimeter to the agent's reasoning. At decision time:

1. The agent calls a TEE and receives sealed reasoning + a cryptographic signature.
2. It commits the hash of `(action + reasoning)` onchain, identified by its ENS name (e.g. `forge.pulseagent.eth`) and ERC-8004 token id.
3. Inside a fixed reveal window, the agent must reveal an action whose hash matches the commitment. Mismatch → automatic ERC-8004 reputation slash. No reveal → expiry slash.
4. On Uniswap v4, `PulseGatedHook` makes wrong-intent swaps physically impossible — they revert before any state change. Off-chain, the agent's swap path goes through the Uniswap Trading API.

The result: continuous reasoning provenance, not point-in-time signature.
Drift between intent and execution becomes detectable, slashable, and — at
the v4 layer — non-executable.

## Components

**`Pulse.sol`** — the commitment primitive. Time-locked commit-reveal of
`(action + sealed reasoning)`. Status transitions: `Pending → Revealed` (kept),
`Pending → Violated` (mismatched reveal), or `Pending → Expired` (no reveal).
ERC-8004 `ReputationRegistry.giveFeedback` fires on every transition.

**`PulseGatedHook.sol`** — Uniswap v4 hook with only `BEFORE_SWAP_FLAG` (no
NoOp surface). Swaps must include `hookData = abi.encode(commitmentId, nonce)`;
the hook either atomically reveals a `Pending` commitment or hash-verifies a
`Revealed` one. Wrong intent → revert before state change.

**ENS Agent Identity** — agents register ENS subnames (e.g.
`forge.pulseagent.eth`) whose text records resolve to their ERC-8004 entry,
TEE signer, and Pulse commitment history. One human-readable handle for the
agent's full provenance.

**Uniswap Trading API integration** — agents compute swap intents via the
Trading API (`trade-api.gateway.uniswap.org/v1/quote`), commit the resulting
`(PoolKey, SwapParams)` hash via Pulse, then execute through a v4 pool wired
with `PulseGatedHook` for protocol-level enforcement.

Reasoning is signed by a TEE provider via standard EIP-191 `personal_sign`.
Onchain verification uses OpenZeppelin's `SignatureChecker` (handles both EOA
and ERC-1271 signers). Reputation flows through the canonical ERC-8004
`ReputationRegistry`.

## Honest scope

- **Demo**: hardware-backed stand-in signer for reliability and reproducibility.
- **Production path**: 0G Compute sealed inference with enclave-born keys.
- The signer is fully pluggable (Phala, Marlin, Oasis, your own enclave).
- Pulse is voluntary signaling for agents that want to prove they're well-behaved. It does not stop bad actors from never opting in. As credit and yield primitives start reading ERC-8004 reputation, non-committing agents get priced out over time.

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
├── agent/                          # reference agent that uses Pulse
└── plugins/
    └── pulse-skills/               # agent-agnostic skill bundle (any agent can install)
.claude/
└── skills/                         # third-party skills consumed in this repo (Uniswap, OZ, Pashov, ethskills, 0g-compute)
```

## Skills

### Consumed in this repo

This repo uses the `Uniswap/uniswap-ai` skills and the OpenZeppelin
`uniswap-hooks` library — the v4 hook here was built using their
`v4-hook-generator` decision table and audited against the
`v4-security-foundations` checklist before commit. See `CLAUDE.md` for the
full skill index and which skill applies to which task.

### Published by this repo: `pulse-skills`

Pulse ships its own agent-agnostic skill bundle so **any** agent runtime
(OpenClaw, Hermes, ElizaOS / Eliza, LangChain, bare Anthropic-API, web3.py)
can plug into Pulse without re-deriving the agent-side know-how.

```bash
# install via skills.sh
npx skills add ss251/ethglobal-openagents

# or via Claude Code marketplace
/plugin install pulse-skills@ss251/ethglobal-openagents
```

| Skill                          | When to use                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `pulse-commit`                 | Bind agent to a hashed action + sealed reasoning at time T.                                              |
| `pulse-reveal`                 | Close a commitment with matching nonce + actionData inside the window.                                   |
| `pulse-status-check`           | Read commitment state cheaply before reveal/swap/expire.                                                 |
| `pulse-gated-swap`             | Execute a Uniswap v4 swap *through* a Pulse commitment — wrong intent doesn't just slash, it reverts.    |
| `sealed-inference-with-pulse`  | Pull TEE-signed reasoning (0G Compute or any EIP-191 signer) and bind it to commit.                      |

Framework adapter recipes for OpenClaw, Hermes, ElizaOS, LangChain,
Anthropic SDK, and Python live in
[`packages/plugins/pulse-skills/integrations/`](packages/plugins/pulse-skills/integrations/).

## Threat model — what Pulse defends against and what it doesn't

Pulse is a signaling and enforcement primitive for *committing* agents. It
does not pretend to be a fortress against *non-committing* adversaries. The
honest table:

| Attack | Defended? | Notes |
| --- | --- | --- |
| Agent reasoning drifts between commit and execution (injection, social engineering, rationalization) | **Yes** for v4 swaps via `PulseGatedHook` (revert before state change). **Yes** for non-swap actions via direct `Pulse.reveal` mismatch detection + ERC-8004 slash. | The core thing Pulse is designed for. |
| Atomic-reveal rollback gap: hook reverts on mismatch, the would-be `Violated` state rolls back too | **Mitigated** via `scripts/watch-and-slash.ts`, a watcher service that calls `Pulse.reveal` directly with the mismatched data outside the hook flow. Locks in the slash. | See SPEC §"Atomic-reveal rollback note." |
| Front-run on reveal broadcast | **Mitigated for swaps** (atomic reveal inside `beforeSwap`). Open for non-swap actions — use private mempool (Flashbots Protect) for those. | |
| Malicious operator never opts in | **Not defended.** Pulse is voluntary. The defense is downstream: as credit, yield, and task layers price ERC-8004 reputation, non-committing agents get worse terms over time. | |
| Reputation farming via trivial commitments | **Not defended in v0.3.** Future work: stake-weighted reputation. | |
| Vague reasoning that covers any future action | **Partial.** Pulse certifies hash equality, not semantic specificity. Recommend a minimum-substance reasoning policy enforced off-chain by reviewers. | |
| Selective reveal / optionality (commit to multiple actions, reveal the favorable one) | **Not defended in v0.3.** Each unrevealed commitment costs `-500` rep on expiry. Profitable only if reputation isn't economically priced. | |
| Sybil / burner agents | **Inherits ERC-8004 weakness.** No proof-of-personhood. | |
| `signerProvider` is an EOA pretending to be a TEE | **Honestly disclosed.** The contract checks ECDSA recovery, not attestation. README, SPEC, and demo UI all explicitly label "stand-in vs production 0G enclave-born key." | |
| Wash-trade reputation between same-owner agents | **Inherited ERC-8004 weakness.** | |
| Honest-on-paper, malicious-in-practice business model | **Not defended.** Pulse certifies *consistency*, not *quality of intent.* | |

The `watch-and-slash.ts` watcher is the single most important post-deployment
operational addition — it closes the atomic-reveal rollback gap without
contract changes.

## Status

### Deployed on Base Sepolia (chainId 84532)

| Contract | Address | Explorer |
| --- | --- | --- |
| **Pulse** | `0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34` | [Basescan](https://sepolia.basescan.org/address/0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34) |
| **PulseGatedHook** | `0x137002596a3a818B36d82490cF79B35c376e8080` | [Basescan](https://sepolia.basescan.org/address/0x137002596a3a818B36d82490cF79B35c376e8080) |

Hook permission flags = `0x0080` = `BEFORE_SWAP_FLAG` only (no NoOp surface,
no `beforeSwapReturnDelta`). Mined via CREATE2 salt 57991.

Wires into:
- ERC-8004 IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- ERC-8004 ReputationRegistry `0x8004B663056A597Dffe9eCcC1965A193B7388713`
- Uniswap v4 PoolManager `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408`

Full deployment record (constructor args, gas, dependencies) at
[`deployments/base-sepolia.json`](deployments/base-sepolia.json).

### Tests: 17 passing

- Pulse: commit, reveal-match, reveal-mismatch, reveal-too-early, expire,
  wrong-signer, non-owner reverts
- PulseGatedHook: atomic-reveal swap, separate-reveal swap, missing
  commitment, mismatched intent, pre-window, post-deadline, malformed
  hookData, expired status, separate-mismatch-locks-Violated, double-spend
  edge case

## License

MIT.
