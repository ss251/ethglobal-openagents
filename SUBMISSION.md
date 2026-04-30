# ETHGlobal Open Agents 2026 — Submission Checklist

Paste-ready content for `https://ethglobal.com/events/openagents/project`.
Everything below is verified live; addresses are on the deployed contracts;
script invocations are reproducible from `main` at tag `v0.6.0`.

> **Tag of record for the submission**: [v0.6.0](https://github.com/ss251/ethglobal-openagents/releases/tag/v0.6.0)

---

## Project description (short)

**Pulse makes AI agents non-repudiable for the on-chain decisions they
execute.** Before acting, an agent commits a hash of `(intent + sealed
TEE reasoning)` on chain. Inside a reveal window it must reveal an
action that hashes to the same commitment — anything else is a slashable
`-1000` ERC-8004 reputation hit. On Uniswap v4 the same primitive is
enforced atomically in `beforeSwap`: a drifted swap reverts before any
state change. Identity is `pulseagent.eth` (ENS + ERC-8004 + ENSIP-25
verification) and travels across chains via an ERC-7857 iNFT on 0G
Galileo. A reference consumer (`PulseGatedLendingPool`) shows downstream
protocols how to gate real-money flows on Pulse-tagged reputation in
two lines of code.

## Project description (long)

The hardest-to-audit component in any agent-driven protocol is the
agent's *reasoning* — and audits never see it. A model can be injected,
drifted, or socially engineered, and the contract executes the resulting
action exactly as written. The next big DeFi exploit will not be a smart
contract bug. It will be an agent that decided to do the wrong thing, in
language audits cannot evaluate, against a user who had no way to know
it was about to happen. Pulse extends the audit perimeter to the
reasoning itself.

At decision time, the agent (1) calls a 0G Compute TEE for sealed
reasoning + EIP-191 signature; (2) commits
`keccak256(nonce || abi.encode(action))` plus the sealed-reasoning CID
on chain, identified by its ENS name and ERC-8004 token id; (3) inside a
fixed reveal window must reveal an action whose hash matches the
commitment. Mismatch fires `-1000` to ERC-8004 reputation; no reveal
fires `-500`; a kept commitment fires `+100`. On Uniswap v4,
`PulseGatedHook` makes the gating atomic in `beforeSwap` — a wrong
intent reverts before any state change.

Identity persists across owners. The agent's ENS name (`pulseagent.eth`)
carries the ENSIP-25 agent-registry verification record, five
descriptive text records, and an IPFS contenthash for the live demo
frontend. It also resolves to an ERC-7857 iNFT (`PulseAgentINFT`) on 0G
Galileo that holds the encrypted state and commitment history — transfer
the iNFT and the new owner inherits the full reputation trail.

The protocol ships with two reference consumers:
**`PulseGatedGate`** answers "does this agent pass?" — a 110-line
contract any protocol can fork to gate behavior on Pulse-tagged
reputation. **`PulseGatedLendingPool`** answers "what does that look
like in a real flow?" — an overcollateralized credit primitive where
the borrow path is gated on Pulse rep through one
`IPulseGate.assertGate(agentId)` call. Both are deployed live on Eth
Sepolia and exercised end-to-end (live borrow tx as agent #3906
demonstrates the gate gating real on-chain capital).

Production-ready operator infrastructure ships as a KeeperHub workflow
that sweeps stuck-Pending commitments past their reveal window,
replacing the always-on expirer daemon Pulse used to need.

---

## Repository

- **GitHub**: <https://github.com/ss251/ethglobal-openagents>
- **Submission tag**: [v0.9.0](https://github.com/ss251/ethglobal-openagents/releases/tag/v0.9.0)
- **License**: MIT
- **README**: <https://github.com/ss251/ethglobal-openagents#readme>
- **Spec**: [SPEC.md](SPEC.md)
- **Integrating in 30 minutes**: [INTEGRATING.md](INTEGRATING.md)
- **LLM-discoverable**: [llms.txt](llms.txt) + [llms-full.txt](llms-full.txt)
- **Tests**: 56 forge tests passing (6 Pulse + 11 PulseGatedHook + 10 PulseAgentINFT + 14 PulseGatedGate + 15 PulseGatedLendingPool)

---

## Deployed contracts

### Eth Sepolia (chainId 11155111)

| Contract | Address | Explorer |
| --- | --- | --- |
| **Pulse** | `0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34` | [Etherscan](https://sepolia.etherscan.io/address/0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34) |
| **PulseGatedHook** | `0x274b3c0f55c2db8c392418649c1eb3aad1ecc080` | [Etherscan](https://sepolia.etherscan.io/address/0x274b3c0f55c2db8c392418649c1eb3aad1ecc080) |
| **pUSD (mock)** | `0xB1e9c59B50D3b79cA09f4f9fd6ca5cC027EAeDDA` | [Etherscan](https://sepolia.etherscan.io/address/0xB1e9c59B50D3b79cA09f4f9fd6ca5cC027EAeDDA) |
| **pWETH (mock)** | `0xC8d229E60C4a02fA49D060B1f0b08D956E6ef349` | [Etherscan](https://sepolia.etherscan.io/address/0xC8d229E60C4a02fA49D060B1f0b08D956E6ef349) |
| **PulseGatedGate** | `0x4d11e22268b8512B01dA7182a52Ba040A0709379` | [Etherscan](https://sepolia.etherscan.io/address/0x4d11e22268b8512B01dA7182a52Ba040A0709379) |
| **PulseGatedLendingPool** | `0x9b3f062faa2934b8ba0bc4c8b1ab4315c2b24b16` | [Etherscan](https://sepolia.etherscan.io/address/0x9b3f062faa2934b8ba0bc4c8b1ab4315c2b24b16) |

Wired to:
- ERC-8004 IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- ERC-8004 ReputationRegistry `0x8004B663056A597Dffe9eCcC1965A193B7388713`
- Uniswap v4 PoolManager `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`
- 0G Compute provider `0xa48f01287233509FD694a22Bf840225062E67836` (qwen-2.5-7b-instruct, TEE-attested)

### 0G Galileo testnet (chainId 16602)

| Contract | Address | Explorer |
| --- | --- | --- |
| **PulseAgentINFT** (ERC-7857) | `0x180D8105dc415553e338BDB06251e8aC3e48227C` | [Chainscan](https://chainscan-galileo.0g.ai/address/0x180D8105dc415553e338BDB06251e8aC3e48227C) |

tokenId #1 holds `pulseagent.eth`'s encrypted state + 10-commitment history.

### ENS (Sepolia)

- **`pulseagent.eth`** — five text records bound via the Public Resolver:
  `agentId`, `signerProvider`, `pulseHistory`, `description`, `avatar`,
  plus `0g.inft = 0g-galileo:16602:0x180D8105…:1` resolving the iNFT from
  the agent's name. View at <https://sepolia.app.ens.domains/pulseagent.eth>.

---

## Prize tracks (in submission order)

### 0G Labs — Compute (Sealed Inference)

**What we built.** TEE-attested sealed reasoning bound to every Pulse
commitment. The agent calls 0G Compute (qwen-2.5-7b-instruct, provider
`0xa48f01287233509FD694a22Bf840225062E67836`), gets back the reasoning
text + an EIP-191 signature over
`keccak256(agentId || intentHash || reasoningCID || executeAfter)`. The
signature is verified on chain by `Pulse.commit` via OpenZeppelin's
`SignatureChecker` (handles EOA + ERC-1271). The reasoning CID becomes
part of the on-chain commitment record — drift detection is signature-
backed, not "trust the agent's logs."

**Live demo**:
```bash
bun run scripts/sealed-inference-demo.ts
```
Output: a 0G-attested reasoning blob is hashed into `reasoningCID` and
anchored on chain in a real Pulse commitment. Tx hash printed.

**Code**:
- [`packages/sdk/src/zg.ts`](packages/sdk/src/zg.ts) — `sealedReason`, `fetchSealedReasoning`
- [`scripts/sealed-inference-demo.ts`](scripts/sealed-inference-demo.ts) — demo
- [`packages/plugins/pulse-skills/skills/sealed-inference-with-pulse/SKILL.md`](packages/plugins/pulse-skills/skills/sealed-inference-with-pulse/SKILL.md) — skill

### 0G Labs — INFTs (ERC-7857)

**What we built.** `PulseAgentINFT` — a complete ERC-7857 intelligent NFT
implementation deployed on 0G Galileo. tokenId #1 carries `pulseagent.eth`'s
encrypted state blob (AES-256-GCM, hash anchored on-chain), the Pulse
identity binding (ERC-8004 token id 3906, namehash of `pulseagent.eth`,
Pulse contract address, chainId 11155111), and an append-only history of
Pulse commitment IDs. Transfer the iNFT and the new owner inherits the
full reputation trail — drift is provable across owners. 10 forge tests
pass (mint, signature-rejection, Pulse binding, commitment append + clone
inheritance, authorize-usage, signer rotation, ERC-165 interfaces).

**Live demo**:
```bash
bun run scripts/inft-bind.ts          # mint + bind + record commitments
```

**Code**:
- [`contracts/inft/PulseAgentINFT.sol`](contracts/inft/PulseAgentINFT.sol)
- [`packages/sdk/src/inft.ts`](packages/sdk/src/inft.ts) — full primitive surface
- [`packages/plugins/pulse-skills/skills/pulse-inft/SKILL.md`](packages/plugins/pulse-skills/skills/pulse-inft/SKILL.md)
- [`script/DeployINFT.s.sol`](script/DeployINFT.s.sol)

### Uniswap — v4 hook + Trading API

**What we built.** `PulseGatedHook` — a Uniswap v4 hook with only
`BEFORE_SWAP_FLAG` (no NoOp surface, no `beforeSwapReturnDelta`). Swaps
must include `hookData = abi.encode(commitmentId, nonce)`; the hook either
atomically reveals a `Pending` commitment or hash-verifies a `Revealed`
one. Wrong intent → revert before state change. CREATE2-mined salt 57991
to embed the permission flags in the address. 11 forge tests covering
atomic-reveal, separate-reveal, missing/mismatched/expired commitment,
malformed hookData, double-spend edge case.

The agent's swap intent is sourced live from the **Uniswap Trading API**
(`trade-api.gateway.uniswap.org/v1/quote`) — quote → normalize into
`(PoolKey, SwapParams)` → commit hash → execute through the hook-gated
pool. The commitment carries the quote's `requestId` so anyone can
re-pull and verify against current liquidity.

**Live demos**:
```bash
bun run scripts/exercise-gated-swap.ts        # naked swap rejected, Pulse-bound swap admits
bun run scripts/violation-and-rollback-demo.ts # drift reverts, watcher locks Violated
bun run scripts/phase8-tradingapi-demo.ts      # Trading API quote → committed on chain
```

**Code**:
- [`contracts/hooks/PulseGatedHook.sol`](contracts/hooks/PulseGatedHook.sol)
- [`packages/sdk/src/hook.ts`](packages/sdk/src/hook.ts) — `intentHashForSwap`, `encodeHookData`
- [`packages/sdk/src/trading.ts`](packages/sdk/src/trading.ts) — Trading API integration
- [`packages/plugins/pulse-skills/skills/pulse-gated-swap/SKILL.md`](packages/plugins/pulse-skills/skills/pulse-gated-swap/SKILL.md)
- [`FEEDBACK.md`](FEEDBACK.md) — required Trading API builder feedback

### ENS — agent identity (deepened in v0.8.0)

**What we built.** `pulseagent.eth` on Sepolia ENS is the agent's
human-readable handle. v0.8.0 deepens the surface across **five
orthogonal axes** that any ENS-aware client can leverage:

1. **Profile records** — six text records resolve the agent's full
   provenance: `agentId` (ERC-8004 token id 3906), `signerProvider`
   (TEE address), `pulseHistory`, `description`, `avatar`, plus
   `0g.inft = 0g-galileo:16602:0x180D…:1` cross-linking the iNFT.
2. **ENSIP-25 verification** — the canonical
   [October 2025 spec](https://docs.ens.domains/ensip/25) for binding
   ENS names to agent registries. Set live as
   `agent-registration[<ERC-7930-encoded ERC-8004 registry>][3906] = "1"`.
   Implemented end-to-end in `@pulse/sdk` (`encodeERC7930Address`,
   `readENSIP25`, `writeENSIP25`).
3. **IPFS contenthash** — gate frontend pinned via local kubo, CIDv1
   `bafybeieq…tfi`, bound on chain via `setContenthash`.
4. **Named smart contracts** — every deployed contract has a self-
   documenting subname under `pulseagent.eth`: `pulse.`, `hook.`,
   `gate.`, `inft.`, `lend.` — each with a `description` text record.
5. **ENS input in the gate frontend** — type `pulseagent.eth`, page
   resolves to the agent id, runs the gate, and renders a phosphor-
   green ✓ ENSIP-25 VERIFIED badge with the canonical record key.

**Live demos**:
```bash
bun run scripts/ens-bind-demo.ts          # 5 text records + commit via ENS-only data
bun run scripts/ens-set-ensip25.ts --execute   # canonical ENSIP-25 record
bun run scripts/ens-set-contenthash.ts --cid <CID> --execute  # IPFS binding
bun run scripts/ens-name-contracts.ts --execute   # 5 contract subnames in 15 txs
```

**Code**:
- [`packages/sdk/src/ens.ts`](packages/sdk/src/ens.ts)
- [`packages/sdk/src/ensip25.ts`](packages/sdk/src/ensip25.ts) — full ENSIP-25 + ERC-7930 surface
- [`scripts/ens-bind-demo.ts`](scripts/ens-bind-demo.ts), [`scripts/ens-set-ensip25.ts`](scripts/ens-set-ensip25.ts), [`scripts/ens-set-contenthash.ts`](scripts/ens-set-contenthash.ts), [`scripts/ens-name-contracts.ts`](scripts/ens-name-contracts.ts)

### KeeperHub — operator infrastructure as a workflow (NEW in v0.6.0)

**What we built.** Pulse's expirer was the last piece of always-on
operator infrastructure the protocol team had to run: someone, somewhere,
calling `Pulse.markExpired(id)` on every Pending commitment past its
reveal window so the agent's `-500` ERC-8004 slash actually posts. v0.6.0
ports that logic to a KeeperHub workflow — keeper network handles cron +
gas + reliability — *and* ships an off-network local fallback so the
work always gets done.

**Three interchangeable shapes:**
| Shape | When |
| --- | --- |
| KeeperHub workflow `*/5 * * * *` ([`keeperhub/workflows/pulse-mark-expired.json`](keeperhub/workflows/pulse-mark-expired.json)) | Default for production |
| Local one-shot ([`scripts/keeperhub-mark-expired.ts`](scripts/keeperhub-mark-expired.ts)) | Off-network fallback (any funded EOA — `markExpired` is permissionless) |
| Agent skill ([`keeperhub-bind`](packages/plugins/pulse-skills/skills/keeperhub-bind/SKILL.md)) | Agent-facing wrapper for both modes |

**Verified live on Eth Sepolia 2026-04-29:** 8 stuck-Pending cids
(#6, #7, #8, #11, #17, #21, #25, #26) swept and marked Expired in ~30s
with `-500` ERC-8004 rep slash each on-chain.

**Code**:
- [`keeperhub/`](keeperhub/) — workflow JSON + README
- [`scripts/keeperhub-mark-expired.ts`](scripts/keeperhub-mark-expired.ts)
- [`packages/plugins/pulse-skills/skills/keeperhub-bind/SKILL.md`](packages/plugins/pulse-skills/skills/keeperhub-bind/SKILL.md)

**Honest scope:** `watch-and-slash.ts` (atomic-reveal rollback recovery)
does not port to a declarative KeeperHub workflow because it needs custom
calldata decoding. The boundary is documented honestly in
[`keeperhub/README.md`](keeperhub/README.md).

---

## Reference consumers — closing the consumption story (v0.7.0 + v0.9.0)

Pulse without consumers is a one-sided primitive. The protocol ships
**two reference consumer patterns** that turn the abstract gate into a
shape downstream protocols can fork in an afternoon:

### `PulseGatedGate` (v0.7.0) — the abstract gate

A 110-line contract that reads canonical ERC-8004 `getSummary` filtered
by `tag1="pulse"` and Pulse-as-client, then approves/rejects above a
configurable threshold. Three variants: pure-view `gate(agentId)`,
reverting `assertGate(agentId)`, and event-emitting `checkAndLog`. Two
lines of integration:

```solidity
import {IPulseGate} from "./gates/PulseGatedGate.sol";
IPulseGate(GATE).assertGate(agentId); // reverts if rep < threshold
```

Deployed at [`0x4d11…9379`](https://sepolia.etherscan.io/address/0x4d11e22268b8512B01dA7182a52Ba040A0709379) — alias `gate.pulseagent.eth`.

### `PulseGatedLendingPool` (v0.9.0) — real-shaped consumer

A minimal overcollateralized credit primitive where the **borrow** path
is gated on Pulse-tagged reputation through one `assertGate` call.
Supply, repay, and liquidate stay permissionless — only borrowing trust
requires reputation. Borrowing is the cleanest archetype of "trust
granted up front, settled later" — exactly what Pulse rep should price.

Deployed at [`0x9b3f…4b16`](https://sepolia.etherscan.io/address/0x9b3f062faa2934b8ba0bc4c8b1ab4315c2b24b16) — alias `lend.pulseagent.eth`.

**Verified live: agent #3906 borrowed real capital through the gate.**
Seed → 50,000 pUSD borrowable liquidity. End-to-end exercise:
`approve(0.1 pETH)` → `supply(0.1 pETH)` → `borrow(3906, 0.04 pUSD)` at
40% LTV. Borrow tx
[`0xdb6e…5f7a`](https://sepolia.etherscan.io/tx/0xdb6e62d8e2dfcdbe36c316c45df4d725f88a99be4eece8f1e71cd5d653b45f7a)
shows the Pulse gate gating real on-chain capital.

### Reference frontend — `apps/gate/`

Single static HTML, viem from CDN, oscilloscope/biomonitor aesthetic.
Pinned to IPFS, contenthash bound to `pulseagent.eth`. Type an ENS name
or numeric agent id, see the EKG trace, the ENSIP-25 verified badge,
the 6 most recent commitment events — all pulled live from chain. URL:
[`https://ipfs.io/ipfs/bafybeieqgxuaptzej2snkcnbfn6wfksrslo5dflpptwehusevwbn4bmtfi/`](https://ipfs.io/ipfs/bafybeieqgxuaptzej2snkcnbfn6wfksrslo5dflpptwehusevwbn4bmtfi/?agent=pulseagent.eth).

---

## Hermes (NousResearch) — autonomous Pulse-bound trading agent in Telegram

`pulseagent.eth` runs as an autonomous agent inside a sandboxed
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
container. Chat with it on Telegram. The agent has a persona
(`hermes-sandbox/SOUL.md`), a wallet (the agent EOA, ERC-8004 #3906), the
full nine-skill `pulse-skills` bundle loaded by name via SkillUse, and the
full Hermes tool catalog (memory, cronjob, todo, clarify, terminal, file).
Demo-ready prompts in the README.

---

## Composable by design — `@pulse/sdk` and `pulse-skills`

Pulse is shipped as a real consumable library, not a one-off demo:

- **`@pulse/sdk`** (npm-shaped, builds to `dist/`, 10 modules) — `pulse`,
  `hook`, `zg` (0G Compute), `ens`, `ensip25` (ERC-7930 + ENSIP-25
  helpers), `trading` (Uniswap), `inft` (ERC-7857), helpers, ABIs,
  types. Any TS app does
  `import {commitIntent, intentHashForSwap, mintINFT, readENSIP25} from "@pulse/sdk"`
  and goes.
- **`pulse-skills`** — installable agent-agnostic skills via
  `npx skills add ss251/ethglobal-openagents` or
  `/plugin install pulse-skills@ss251/ethglobal-openagents`. **Six**
  framework integration recipes (Anthropic SDK, Hermes, LangChain v1,
  ElizaOS, OpenClaw, Python) — every recipe verified against current
  official docs as of 2026-Q1, not training-time guesses.
- **Two reference consumer contracts** (`PulseGatedGate`,
  `PulseGatedLendingPool`) and a **single static-HTML reference
  frontend** (`apps/gate/`) so the answer to "how do I read Pulse rep?"
  is "clone this folder."

---

## Submission form fields (paste these into `ethglobal.com/events/openagents/project`)

> Verify each prize-track checkbox is ticked: **0G Compute, 0G iNFT, Uniswap, ENS, KeeperHub.**

- **Project name**: Pulse
- **Short description**: Pulse makes AI agents non-repudiable for the on-chain decisions they execute. Agents commit a hash of (intent + sealed TEE reasoning) before acting. Drift is slashable on ERC-8004; on Uniswap v4 the hook reverts wrong-intent swaps before any state change. Identity travels via ENS + ENSIP-25 + ERC-7857 iNFT on 0G. A live lending-pool reference consumer shows downstream protocols how to gate real-money flows on Pulse rep in two lines.
- **Long description**: (paste the "Project description (long)" block above)
- **Source code**: <https://github.com/ss251/ethglobal-openagents> (tag v0.9.0)
- **Demo video**: TODO — see "90-second video plan" in README. Lead with
  the drift-and-revert demo (agent tries to skip its committed swap →
  `PulseGatedHook` reverts before state change → ERC-8004 -1000 slash
  posts via watcher), then the live `PulseGatedLendingPool` borrow as
  agent #3906, then the gate frontend's `✓ ENSIP-25 VERIFIED` badge.
- **Live deployment**: see "Deployed contracts" table above. ENS-named
  aliases: `pulse.pulseagent.eth`, `hook.pulseagent.eth`,
  `gate.pulseagent.eth`, `lend.pulseagent.eth`, `inft.pulseagent.eth`.
- **What's next**: stake-weighted reputation; minimum-substance
  reasoning policy; selective-reveal mitigation via per-agent commitment
  caps; outreach + integration with HeyElsa / Almanak / Olas (PolyStrat)
  / Virtuals — the four named projects with concrete 2026 on-chain
  agent activity that fit the Pulse pattern most cleanly.

---

## Pre-submit verification (run before you click Submit)

```bash
# 1. Tests still green
forge test
# expect: 56 passing (6 + 11 + 10 + 14 + 15)

# 2. Sweep is idempotent (no stuck Pending left)
bun run scripts/keeperhub-mark-expired.ts
# expect: expirableCount=0

# 3. Trading API still returns a quote (Uniswap track)
bun run scripts/phase8-tradingapi-demo.ts | head -5
# expect: requestId + intentHash printed, commitment tx hash

# 4. Lending pool gate still gates a real borrow (v0.9.0 demand-side proof)
cast call 0x9b3f062faa2934b8ba0bc4c8b1ab4315c2b24b16 "currentLtvBps(address)(uint256)" \
  "$(cast wallet address --private-key $AGENT_PRIVATE_KEY)" --rpc-url $SEPOLIA_RPC_URL
# expect: 4000 (40% LTV — agent #3906's outstanding borrow)

# 5. ENSIP-25 record still resolves on Sepolia
cast call 0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5 "text(bytes32,string)(string)" \
  "$(cast namehash pulseagent.eth)" \
  "agent-registration[0x0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e][3906]" \
  --rpc-url $SEPOLIA_RPC_URL
# expect: "1"

# 6. Hermes container is up (if recording the video)
docker ps --filter name=hermes --format '{{.Names}} {{.Status}}'
```

If all six pass, the submission claims hold.

---

## Gensyn AXL — not pursued

Gensyn AXL is the only listed prize track without dedicated work in
this repo as of v0.9.0. Decision logged 2026-04-30 to skip and lean
into the five-track depth (0G Compute, 0G iNFT, Uniswap v4, ENS,
KeeperHub) plus the v0.7.0 + v0.9.0 reference consumers. Time is
better spent making the existing tracks undeniable than diluting them
to chase a sixth.

If a future build wants to chase it: Gensyn's RL Swarm or testnet
compute could be the attestation source for sealed reasoning instead
of (or alongside) 0G Compute — the `signerProvider` slot is
intentionally pluggable. That's a ~2-day insertion that doesn't break
existing flows.
