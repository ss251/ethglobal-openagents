# ETHGlobal Open Agents 2026 — Submission Checklist

Paste-ready content for `https://ethglobal.com/events/openagents/project`.
Everything below is verified live; addresses are on the deployed contracts;
script invocations are reproducible from `main` at tag `v0.6.0`.

> **Tag of record for the submission**: [v0.6.0](https://github.com/ss251/ethglobal-openagents/releases/tag/v0.6.0)

---

## Project description (short)

**Pulse — Sealed Agent Commitments.** AI agents commit their decisions
*before* they execute them. Sealed reasoning (0G Compute TEE), commit-reveal
on Eth Sepolia, ERC-8004 reputation slashing on drift, and a Uniswap v4
hook that makes wrong-intent swaps physically impossible (revert before any
state change). Identity is `pulseagent.eth` on ENS, minted as an ERC-7857
intelligent NFT on 0G Galileo with append-only commitment history. Operator
infrastructure runs as a KeeperHub workflow — zero always-on boxes.

## Project description (long)

The hardest-to-audit component in any agent-driven protocol is the agent's
*reasoning* — and audits never see it. A model can be injected, drifted, or
socially engineered, and the contract executes the resulting action exactly
as written. Pulse extends the audit perimeter to the reasoning itself.

At decision time, the agent (1) calls a 0G Compute TEE for sealed reasoning
+ EIP-191 signature, (2) commits `keccak256(nonce || abi.encode(PoolKey,
SwapParams))` and the sealed-reasoning CID on-chain, identified by its ENS
name and ERC-8004 token id, (3) inside a fixed reveal window must reveal an
action whose hash matches the commitment — mismatch is a `-1000` ERC-8004
slash, no reveal is `-500`, kept is `+100`. On Uniswap v4, `PulseGatedHook`
makes the gating atomic in `beforeSwap` — wrong intent reverts before any
state change. Identity persists across owners: the agent's ENS name resolves
to its ERC-8004 entry and to an ERC-7857 iNFT on 0G that carries the
encrypted state + commitment history; transfer the iNFT and the new owner
inherits the rep trail.

Production-ready operator infrastructure ships as a KeeperHub workflow that
sweeps stuck-Pending commitments past their reveal window, replacing the
always-on expirer daemon Pulse used to need.

---

## Repository

- **GitHub**: <https://github.com/ss251/ethglobal-openagents>
- **Submission tag**: [v0.6.0](https://github.com/ss251/ethglobal-openagents/releases/tag/v0.6.0)
- **License**: MIT
- **README**: <https://github.com/ss251/ethglobal-openagents#readme>
- **Spec**: [SPEC.md](SPEC.md)
- **Integrating in 30 minutes**: [INTEGRATING.md](INTEGRATING.md)
- **LLM-discoverable**: [llms.txt](llms.txt) + [llms-full.txt](llms-full.txt)
- **Tests**: 41 forge tests passing (6 Pulse + 11 PulseGatedHook + 10 PulseAgentINFT + 14 PulseGatedGate)

---

## Deployed contracts

### Eth Sepolia (chainId 11155111)

| Contract | Address | Explorer |
| --- | --- | --- |
| **Pulse** | `0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34` | [Etherscan](https://sepolia.etherscan.io/address/0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34) |
| **PulseGatedHook** | `0x274b3c0f55c2db8c392418649c1eb3aad1ecc080` | [Etherscan](https://sepolia.etherscan.io/address/0x274b3c0f55c2db8c392418649c1eb3aad1ecc080) |
| **pUSD (mock)** | `0xB1e9c59B50D3b79cA09f4f9fd6ca5cC027EAeDDA` | [Etherscan](https://sepolia.etherscan.io/address/0xB1e9c59B50D3b79cA09f4f9fd6ca5cC027EAeDDA) |
| **pWETH (mock)** | `0xC8d229E60C4a02fA49D060B1f0b08D956E6ef349` | [Etherscan](https://sepolia.etherscan.io/address/0xC8d229E60C4a02fA49D060B1f0b08D956E6ef349) |

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

### ENS — agent identity

**What we built.** `pulseagent.eth` on Sepolia ENS is the agent's
human-readable handle. Five text records resolve to the agent's full
provenance — `agentId` (ERC-8004 token id), `signerProvider` (TEE
provider address), `pulseHistory` (recent commitment ids), `description`,
`avatar`, plus `0g.inft = 0g-galileo:16602:<inft>:<id>` linking the iNFT.
Downstream tooling (and the `pulseProvenanceFromENS()` helper in
`@pulse/sdk`) takes just the name and resolves `(addr, agentId, TEE
signer, iNFT location)` without ever reading the agent's `.env`.

**Live demo**:
```bash
bun run scripts/ens-bind-demo.ts
# binds 5 text records, resolves them back via pulseProvenanceFromENS(),
# then commits via Pulse using ONLY ENS-resolved data — proves ENS does
# real work in the agent identity stack
```

**Code**:
- [`packages/sdk/src/ens.ts`](packages/sdk/src/ens.ts)
- [`scripts/ens-bind-demo.ts`](scripts/ens-bind-demo.ts)

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

- **`@pulse/sdk`** (npm-shaped, builds to `dist/`, 9 modules) — `pulse`,
  `hook`, `zg` (0G Compute), `ens`, `trading` (Uniswap), `inft`
  (ERC-7857), helpers, ABIs, types. Any TS app does
  `import {commitIntent, intentHashForSwap, mintINFT} from "@pulse/sdk"`
  and goes.
- **`pulse-skills`** — installable agent-agnostic skills via
  `npx skills add ss251/ethglobal-openagents` or
  `/plugin install pulse-skills@ss251/ethglobal-openagents`. **Six**
  framework integration recipes (Anthropic SDK, Hermes, LangChain v1,
  ElizaOS, OpenClaw, Python) — every recipe verified against current
  official docs as of 2026-Q1, not training-time guesses.

---

## Submission form fields (paste these into `ethglobal.com/events/openagents/project`)

> Verify each prize-track checkbox is ticked: **0G Compute, 0G iNFT, Uniswap, ENS, KeeperHub.**

- **Project name**: Pulse
- **Short description**: Sealed agent commitments — galaxy-brain-resistant onchain decisions. Agents commit reasoning + intent before they execute, with Uniswap v4 hook gating, ERC-8004 reputation slashing, ENS identity, ERC-7857 iNFT on 0G, and KeeperHub-deployable expirer infrastructure.
- **Long description**: (paste the "Project description (long)" block above)
- **Source code**: <https://github.com/ss251/ethglobal-openagents>
- **Demo video**: TODO — record a Telegram-bot trace ending with the
  drift+slash demo (`Now drift the agent — execute a different swap than
  what was committed.` from the Hermes prompts table)
- **Live deployment**: see "Deployed contracts" table above; etherscan +
  chainscan-galileo links per contract
- **What's next**: stake-weighted reputation; minimum-substance reasoning
  policy; selective-reveal mitigation via per-agent commitment caps

---

## Pre-submit verification (run before you click Submit)

```bash
# 1. Tests still green
forge test
# expect: 41 passing (6 + 11 + 10 + 14)

# 2. Sweep is idempotent (no stuck Pending left)
bun run scripts/keeperhub-mark-expired.ts
# expect: expirableCount=0

# 3. Trading API still returns a quote (Uniswap track)
bun run scripts/phase8-tradingapi-demo.ts | head -5
# expect: requestId + intentHash printed, commitment tx hash

# 4. Hermes container is up (if recording the video)
docker ps --filter name=hermes --format '{{.Names}} {{.Status}}'
```

If all four pass, the submission claims hold.

---

## Gensyn AXL — not yet pursued

Gensyn AXL is the only listed prize track without dedicated work in this
repo as of v0.6.0. With ~3 days to the deadline (today 2026-04-30,
deadline 2026-05-03), adding a new track risks degrading the existing
five. **Recommend skipping.**

If we want to chase it: Gensyn's RL Swarm or testnet compute could be the
attestation source for sealed reasoning instead of (or alongside) 0G
Compute — the `signerProvider` slot is intentionally pluggable. That's a
~2-day insertion and would compete for time with submission polish.
