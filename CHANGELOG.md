# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

GitHub Releases mirror this file; see
<https://github.com/ss251/ethglobal-openagents/releases> for downloadable
archives at each tag.

## [0.7.0] — 2026-04-30 — PulseGatedGate: the read-side reference consumer

The integration story up through v0.6.0 was supply-side complete (any
agent can plug into Pulse to commit + reveal + slash). What was missing:
the *read* side. A protocol team evaluating Pulse had to derive the
"how do I gate my flow on Pulse rep?" answer themselves. v0.7.0 ships
that answer as a single, cloneable artifact.

### Added — the gate

- **`contracts/gates/PulseGatedGate.sol`** — ~110-line reference
  consumer. Reads canonical ERC-8004 `getSummary(agentId, [pulse],
  "pulse", tag2Filter)` and exposes:
  - `gate(agentId) → bool` (pure view — for frontends)
  - `assertGate(agentId)` (revert variant — for one-line composition in
    other contracts: `IPulseGate(GATE).assertGate(agentId)`)
  - `checkAndLog(agentId)` (non-view, emits `GateChecked` for
    indexers / The Graph)
  - Owner-tunable `threshold` (`int128`) and optional `tag2Filter`
    (e.g. only count "kept" feedbacks).
  - Pinned to a single client (Pulse contract) so a malicious party
    can't farm fake `tag1="pulse"` feedback under another address.
- **`test/PulseGatedGate.t.sol`** — 14 tests, all `vm.mockCall`-driven
  against the registry interface so the suite stays unit-isolated.
  Covers passes/fails at threshold boundary, untracked-agent rejection,
  emission shape, owner gates, ctor invariants. Total suite: **41/41
  passing** (was 27).
- **`script/DeployGate.s.sol`** — Foundry deploy script. Defaults to
  the canonical Eth Sepolia ReputationRegistry + Pulse address;
  override via `REPUTATION_REGISTRY` / `PULSE_ADDRESS` /
  `GATE_THRESHOLD` / `GATE_OWNER` env vars.
- **`apps/gate/`** — single static HTML reference frontend. viem from
  `esm.sh` CDN, no build step, no `package.json`. Drop-and-serve. URL
  params for `agent`, `gate`, `pulse`, `threshold`, `rpc`. Reads either
  the deployed `PulseGatedGate` (for threshold + tag2 config) or the
  registry directly. Verified end-to-end against the live deployment:
  `?agent=3906` (`pulseagent.eth`) renders **APPROVED** with
  `count=26 summaryValue=3423 decimals=2` against `threshold=50`.
- **README** + **CHANGELOG** updated with the gate section, repo
  layout entry, and the bumped 41-test count.

### Why this matters

Per Grok's pre-submission pressure test, the load-bearing concern for
Pulse's defensibility was always: "great supply-side primitive, but
will anyone read?" v0.7.0 answers that with the smallest possible
artifact a downstream protocol can clone. Two lines of contract code
(`IPulseGate(GATE).assertGate(agentId)`) and one static HTML page is
the entire consumption story. This is what gets handed to HeyElsa /
Almanak / Olas in pre-submission DMs.

### Verified

- `forge test` → 41/41 pass.
- Live read: agent #3906 on Eth Sepolia returns APPROVED via the
  deployed registry.
- Frontend renders APPROVED + UNTRACKED states correctly (screenshots
  in PR / submission demo).

## [0.6.0] — 2026-04-29 — KeeperHub-deployable expirer

The expirer was Pulse's last piece of always-on operator infrastructure:
without somebody calling `Pulse.markExpired(id)` on stuck Pending
commitments past their reveal window, the agent's reputation never gets
the `-500` slash it earned for missing the window, and `getStatus(id)`
keeps reading "Pending" forever. v0.6.0 ports that logic to KeeperHub
and ships an off-network fallback so the protocol team's operator burden
for the expirer drops from "always-on box" to **none**.

### Added

- **`keeperhub/` directory** at the repo root with a [`README.md`](keeperhub/README.md) that
  documents the operator-infra story, the workflow JSON, the local-script
  fallback, and the boundary of what does *not* port (the
  `watch-and-slash.ts` rollback recovery, which needs custom calldata
  decoding outside KeeperHub's declarative steps).
- **`keeperhub/workflows/pulse-mark-expired.json`** — KeeperHub workflow
  (cron `*/5 * * * *`) with three steps: scan `Committed` events via
  `eth_getLogs` → filter by `block.timestamp >= executeAfter +
  revealWindow` → loop calling `Pulse.markExpired(id)` with
  `gasLimit=500_000`. Workflow metadata includes a `fallback` block
  pointing at the local script as the off-network ground truth.
- **`scripts/keeperhub-mark-expired.ts`** — local sweep script.
  Permissionless (any funded EOA can run it), BigInt-safe JSON output,
  dry-run + execute modes, optional `--ids` for targeted cleanup. Filters
  zero-state commitments via `commitTime > 0n` so the sweep stays
  linear-bounded by issued cid count, not by `uint256` space. Failures
  per id don't abort the sweep — independent loop, full results array
  emitted with `markExpiredTx` on success and `error` on failure.
- **`packages/plugins/pulse-skills/skills/keeperhub-bind/`** — agent skill
  (v0.6.0) wrapping both shapes. Documents when to use the local script
  vs the deployed workflow, the dead-state guard, the env contract,
  and how this composes with `pulse-introspect` / `pulse-status-check`.
  Registered in `plugin.json` and the marketplace manifest.
- **README "KeeperHub integration" section** with the verified-live
  numbers (8 commitments swept, ~30s sweep time, all status=Expired with
  −500 ERC-8004 rep slash on chain), the two-shape table, and the
  operator-infra-burden delta sentence.

### Live verification

Sweep run 2026-04-29 against the deployed Eth Sepolia Pulse
(`0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34`):

```
8 commitments swept and expired:
  cid #6, #7, #8, #11, #17, #21, #25, #26
  → all status=Expired (3), -500 ERC-8004 rep slash each
```

Workflow shape and local-script shape produce identical behavior; the
JSON's three steps and the script's three phases (scan → filter → loop
markExpired) are line-for-line correspondent.

### Bumped

- `packages/plugins/pulse-skills/package.json`: `0.5.0` → `0.6.0`
- `packages/plugins/pulse-skills/.claude-plugin/plugin.json`: `0.5.0` → `0.6.0` (registers `keeperhub-bind` skill, adds `keeperhub` + `expirer` keywords)
- `packages/plugins/pulse-skills/.claude-plugin/marketplace.json`: `0.5.0` → `0.6.0`

## [0.5.0] — 2026-04-29 — Real composability + verified docs + LLM-discoverable

The v0.4 ship had a real iNFT on chain but two product holes: (1) the
encrypt + proof + mint primitives were locked inside `scripts/inft-bind.ts`
so any external integrator had to copy the script, and (2) the framework
integration recipes were written from training-time knowledge — verified
against current official docs, several were wrong. v0.5.0 closes both.

### Added — composability

- **`@pulse/sdk` is a real consumable library**:
  - `packages/sdk/src/inft.ts` — full ERC-7857 primitive surface:
    `encryptStateBlob`, `decryptStateBlob`, `buildMintProof`,
    `buildTransferProof`, `mintINFT`, `bindPulseAgent`, `recordCommitment`,
    `readINFTState`, `extractMintedTokenId`, plus `INFT_ABI`,
    `INFT_HUMAN_READABLE_ABI`, and 0G chain constants
    (`ZG_GALILEO_CHAIN_ID`, `ZG_GALILEO_RPC`, `ZG_STORAGE_INDEXER`).
  - `packages/sdk/src/abi-inft.ts` — full JSON ABI export (parseAbi can't
    represent the `tuple[]` return shape of `commitmentsOf` cleanly).
  - SDK builds cleanly to `dist/` (`tsc` produces `.js` + `.d.ts` for every
    module, 9 modules total).
  - `packages/sdk/package.json` versioned 0.5.0, with `files` array and
    `repository` field — ready for `npm publish` when desired.
- **`INTEGRATING.md`** — 30-minute path from clone to first revealed
  commitment for fresh integrators.
- **`llms.txt` + `llms-full.txt`** — [llmstxt.org](https://llmstxt.org) format
  machine-readable navigation file at repo root, plus a full-content variant
  (5515 lines / 240 KB) with every canonical doc embedded for offline LLM
  consumption.

### Changed — verified docs

Every framework integration recipe was rewritten against **current official
docs as of 2026-Q1** (verified by parallel research subagents pulling the
canonical references):

- **`hermes.md`** — dropped the hallucinated `import {tool} from "hermes-agent"`
  and fake YAML config. Replaced with the ground-truth setup we actually
  used in this repo (`link-skills.sh` symlink + native SkillUse + Telegram
  gateway + Anthropic API key per AUTH_NOTES Finding 3). The agent invokes
  Pulse skills by name through SkillUse — no custom tool registration.
- **`langchain.md`** — migrated v0.2-era patterns to **LangChain JS v1.0**:
  `tool()` factory replaces `DynamicStructuredTool`; `createAgent` from
  `langchain` replaces `createReactAgent` from `@langchain/langgraph/prebuilt`;
  `StateSchema` + `MessagesValue` replace the channels-object pattern.
  Sources: docs.langchain.com/oss/javascript/.
- **`elizaos.md`** — fixed 4 audit findings: (a) secrets via
  `runtime.getSetting()` not `runtime.character.settings.secrets`,
  (b) `examples` use `{name, content}` with `content.actions: string[]`
  not `{user, content: {action}}`, (c) export a `Plugin` wrapper not loose
  actions, (d) character file is **TypeScript** with **top-level**
  `secrets`, not YAML with nested settings. `handler` returns
  `ActionResult` (`{success, text?, data?}`) not bare object.
  Sources: docs.elizaos.ai/plugins/reference.md, character-interface.md.
- **`openclaw.md`** — total rewrite. **Skills are pure markdown**, not
  "SKILL.md + handler.ts". Tools live in a **companion plugin** that uses
  `definePluginEntry({register(api)})` and registers tools via
  `api.registerTool({name, description, parameters: Type.Object({...}), execute})`
  with **TypeBox** parameter schemas, not Zod or JSON-schema. Install via
  `openclaw skills install <slug>` (ClawHub registry) or
  `npx skills add https://github.com/.../<repo> --skill <name>`.
  Sources: docs.openclaw.ai/tools/skills, plugins/building-plugins, clawhub
  skill-format spec.
- **`anthropic-sdk.md`, `python.md`** — already accurate against current
  docs, only added the iNFT pattern.
- **`scripts/inft-bind.ts` refactored to consume `@pulse/sdk`** — inline
  encrypt + crypto + proof + ABI + writeContract calls all replaced with
  imports. Same JSON contract on stdout. Verified: tokenId #2 minted on 0G
  Galileo via the SDK-refactored path.
- pulse-skills plugin/marketplace metadata bumped 0.4.0 → 0.5.0; SDK
  versioned 0.5.0.

### Verified live

- All 27 forge tests pass (no contract changes).
- Direct SDK consumer: `import { readINFTState } from "@pulse/sdk"` works
  out of `dist/`. Commitments #1 + #2 readable from a fresh consumer.

## [0.4.0] — 2026-04-29 — ERC-7857 iNFT on 0G + prize-track full coverage

The agent's identity is now an iNFT. `pulseagent.eth` is minted as
`PulseAgentINFT(tokenId=1)` on 0G Galileo testnet (chainId 16602) at
`0x180D8105dc415553e338BDB06251e8aC3e48227C`. The iNFT anchors the agent's
encrypted state, ENS namehash, ERC-8004 token id (3906), Pulse contract
address, and the full 10-commitment history the agent has made on Eth
Sepolia (#9, #12, #13, #14, #15, #21, #23, #24, #25, #26). Transfer or
clone the iNFT and the new owner inherits the rep trail — every Pulse
commit becomes part of a transferable, encrypted ledger.

Built specifically for the 0G "Best Autonomous Agents, Swarms & iNFT
Innovations" prize track ($7,500), which explicitly names ERC-7857 as
the integration target.

### Added

- **`contracts/inft/PulseAgentINFT.sol`** — single-file ERC-7857
  implementation. Inherits OpenZeppelin `ERC721 + Ownable`, implements
  `IERC7857`, `IERC7857Metadata`, and `IERC7857DataVerifier`. Self-verifier
  pattern (the contract is its own verifier) saves an extra deploy. ECDSA
  proof gates mint/update/transfer/clone — same trust anchor as Pulse's
  `signerProvider`.
- **Pulse-specific extensions on the iNFT**:
  - `bindPulseAgent(tokenId, agentId, ensNode, pulse, pulseChainId)` —
    cross-chain link from iNFT to Pulse identity stack.
  - `recordCommitment(tokenId, commitmentId, pulseChainId)` —
    append-only commitment history per iNFT.
  - `commitmentsOf(tokenId)` view + clone-inheritance so a new owner
    inherits the full Pulse trail.
- **`contracts/inft/IERC7857.sol`, `IERC7857Metadata.sol`, `IERC7857DataVerifier.sol`** —
  vendored verbatim from `0glabs/0g-agent-nft@eip-7857-draft` so
  PulseAgentINFT is interchangeable with any other ERC-7857 implementation.
- **`script/DeployINFT.s.sol`** — Foundry deploy script for 0G Galileo.
  Requires `--legacy --skip-simulation` (Galileo doesn't accept EIP-1559 fee
  fields and the testnet RPC rejects parallel `eth_call` + `sendRawTx`).
- **`scripts/inft-bind.ts`** + `pulse-inft` skill — orchestrator that
  encrypts the agent state blob with AES-256-GCM, hashes the ciphertext,
  builds an ECDSA preimage proof, mints, binds Pulse, records commitments,
  and (optionally) writes the ENS text record `0g.inft` on Sepolia. Single
  JSON object on stdout with all tx hashes.
- **`scripts/_lib/zg.ts`** — viem chain definition for 0G Galileo (chainId
  16602, RPC `https://evmrpc-testnet.0g.ai`, faucet, indexer URL).
- **ENS text record `0g.inft`** at `pulseagent.eth` →
  `0g-galileo:16602:0x180D8105dc415553e338BDB06251e8aC3e48227C:1`. Existing
  `pulseProvenanceFromENS()` readers can discover the iNFT from the
  agent's name without hardcoding addresses.
- **`test/PulseAgentINFT.t.sol`** — 10 forge tests covering the ERC-7857
  surface + the Pulse-specific extensions. All real signatures via
  `vm.sign`, no mocks beyond the signer keypair.

### Changed

- **`FEEDBACK.md` rewritten** with concrete findings from the build
  (Uniswap track requirement). All "TBD" sections replaced with specific
  feedback grounded in real tx hashes — what worked, where I lost time
  (5 specific friction points + suggestions), what I wish existed for
  agent-first builders.
- `pulse-skills` plugin/marketplace metadata bumped 0.3.0 → 0.4.0; skills
  array now lists 9 entries (added `pulse-inft`).
- `SOUL.md` references the new `pulse-inft` skill + `inft-bind.ts`
  helper script.
- README badge: forge test count 17 → 27, release v0.3.0 → v0.4.0,
  added ERC-7857 prize-track shield.

### Verified live (all on chain, all from today)

- Mint tx (0G Galileo): `0x6250a98822f42fa8a6f266bef0fdd83d475ebce45abd8dddcda8c456ad54afcc`
- bindPulseAgent tx: `0x5bd9de34c674ba8c6f2c1d36808ccf5b4d9859d11591b77f6df77736394e0b6a`
- 10 recordCommitment txs (one per Pulse commitment in the agent's history).
- ENS `setText 0g.inft` tx (Eth Sepolia): `0x727e7f3242161f0a8e0517fb57413ad16077135250eca5781bfa1fada9f313d1`
- All 27 forge tests pass (17 legacy + 10 new iNFT).

## [0.3.0] — 2026-04-29 — Integrator pass

Born out of the un-coached Telegram test. With no skill name in the prompt,
the agent autonomously loaded `pulse-autonomous-trade` and committed to
Pulse — proving `SOUL.md` is load-bearing. But the swap reverted (~30k gas)
because `ensureFundedAndApproved` only checked TOKEN0 balance and skipped
minting TOKEN1 (the token actually being sold). The agent then spent twelve
minutes writing inline viem block-scanners and a one-shot retry script
before recovering. v0.3.0 turns that whole detour into a single helper
invocation.

### Added
- **`scripts/_lib/`** — single source of truth shared by every script.
  - `env.ts` explicit `.env` loader that *overrides* shell env. Closes the
    `AGENT_ID=5263`-from-OpenClaw-bot leak that signed commits for the wrong
    agent during the un-coached run.
  - `funding.ts` direction-aware funding. Only checks + mints + approves
    the token actually being sold.
  - `abi.ts`, `pulse.ts`, `output.ts` for ABIs, contract reads, BigInt-safe
    JSON output, fatal-handler wrapper.
- **`scripts/pulse-retry.ts` + `pulse-recover` skill** — first-class
  recovery primitive. Reads on-chain commitment state, validates the reveal
  window, ensures funding, re-submits the gated swap with the original
  nonce. Returns structured `Skipped` results with reason codes when the
  commitment is in a terminal state or past its window.
- **`scripts/pulse-introspect.ts` + `pulse-introspect` skill** — replaces
  the agent's tendency to write inline `eth_getBlock` loops. Two modes:
  recent-activity scan (`--last N` or `--from-block N`) and
  single-commitment inspect (`--commitment-id N`). Decodes function
  selectors against Pulse + ERC-20 + SwapTest ABIs. BigInt-safe.
- **README — "How to plug your agent into Pulse"** section. Documents the
  script surface as the public contract with three guarantees (`.env`
  wins, failures are recoverable, BigInt-safe JSON) and a 3-step minimal
  flow.
- `scripts/check-pool-price.ts`, `scripts/portfolio-check.ts` — agent-authored
  diagnostic helpers from the un-coached debugging run.

### Changed
- **`autonomous-trade.ts` JSON contract** — when the swap reverts, output
  now includes a `recovery` block with the exact `pulse-retry.ts`
  invocation so the agent doesn't have to grep nonces or reconstruct
  hashes.
- `force-drift.ts` refactored on `_lib` for parity with `autonomous-trade.ts`
  (same funding bug fix lands once).
- `SOUL.md` adds a "When something goes wrong" section pointing at
  `pulse-introspect` first, then `pulse-recover` if recoverable, then
  `markExpired` if not. Hard rule: never write inline block-scanners or
  one-shot retry scripts.

### Fixed
- **Direction-aware funding bug.** `ensureFundedAndApproved` previously
  only checked TOKEN0 balance and skipped minting if TOKEN0 was funded.
  When selling TOKEN1 (pETH) with no TOKEN0 shortfall, this caused the
  swap to revert at ~30k gas with `Insufficient balance`. Fixed at the
  `_lib/funding.ts` level so both `autonomous-trade.ts` and
  `force-drift.ts` share the corrected behavior.
- `.env` no longer loses to shell env. Closes a class of cross-bot
  configuration leaks (`AGENT_ID`, signing keys, RPC URLs) when an agent
  container inherits a parent shell.

### Removed
- Interim `scripts/mint-and-retry-swap.ts` (the agent's mid-debug stub)
  superseded by the polished `scripts/pulse-retry.ts`.

### Verified live
- Commitment #12 succeeded end-to-end from the plain prompt
  `Sell 0.005 pETH for at least 1500 pUSD.` with no skill name in the
  message. `getStatus(12) = Revealed`.
- All 17 forge tests still passing.
- `bun run scripts/pulse-introspect.ts --commitment-id 12` returns the
  live Revealed state with full provenance.
- `bun run scripts/pulse-retry.ts --commitment-id 11 …` correctly returns
  `Skipped` with `reveal window expired` reason instead of burning gas.

## [0.2.0] — 2026-04-29 — Autonomous trading agent in Telegram

Pivot from "tool dispatcher in a CLI shim" to a real autonomous agent in
the wild. The standalone `scripts/telegram-pulse-bot.ts` polling shim is
deleted; everything is on Hermes' canonical infrastructure now.

### Added
- **Hermes gateway** (`hermes gateway run` is the container's entrypoint)
  replaces the polling shim entirely. Native Telegram support: persistent
  sessions per `chat_id` in SQLite, voice memos transcribed via Whisper,
  group chats, slash commands, `/model` picker, `/new`/`/reset`.
- **Persona** — `hermes-sandbox/SOUL.md` defines the autonomous trading
  agent identity (pulseagent.eth, ERC-8004 #3906, the wallet, hard rules:
  never execute without committing first). `auth.sh` installs it into the
  container at `/opt/data/SOUL.md`.
- **`pulse-autonomous-trade` keystone skill** —
  `packages/plugins/pulse-skills/skills/pulse-autonomous-trade/SKILL.md`.
  The agent loads it whenever the user gives a trading objective in
  natural language. Instructs the LLM to call
  `scripts/autonomous-trade.ts`, which runs the full reason → commit →
  wait → atomic-reveal swap cycle and emits structured JSON.
- **Force-drift demo** — `scripts/force-drift.ts` commits an honest intent
  A, attempts to execute drifted intent B; v4 hook reverts before any
  state change; watcher closes the rollback gap with a direct
  `Pulse.reveal(B)`; commitment goes Violated, agent slashed −1000
  ERC-8004 reputation.

### Changed
- Full Hermes tool catalog re-enabled (`memory`, `cronjob`, `todo`,
  `clarify`, `skills`). The body-size gate that forced trimming on
  Pro/Max OAuth no longer applies once an Anthropic API key is bound
  alongside (Finding 3 in `AUTH_NOTES.md`).

### Removed
- `scripts/telegram-pulse-bot.ts` polling shim (every problem it solved
  is solved by Hermes' native gateway).

### Scoped (deferred)
- ERC-7857 (0G iNFT) integration captured in issue
  [#1](https://github.com/ss251/ethglobal-openagents/issues/1) for the
  0G Open Agents Track 2 prize.

## [0.1.5] — 2026-04-29 — Pre-publish doc sweep

### Fixed
- `scripts/gen-keys.ts` was writing `https://sepolia.base.org` into freshly
  generated `.env` files; corrected to the publicnode Eth Sepolia RPC.
- Stale `forge.pulseagent.eth` references throughout the codebase replaced
  with the actually-registered `pulseagent.eth`.
- Outward-facing "Pulse Protocol" labels in CLI banners and the diagram
  title shortened to "Pulse" (README header retains the formal name).

## [0.1.4] — 2026-04-29 — Hermes invokes pulse-skills by name

### Changed
- Bound a non-OAuth Anthropic API key alongside the existing OAuth
  credential; re-enabled the `skills` toolset that was previously closed
  off by the Claude Pro/Max body-size gate.

### Verified
- With API key in the credential pool, `hermes` can invoke pulse-skills by
  name via the SkillUse tool. Validated end-to-end with `pulse-status-check`
  on commitment #8: haiku-4-5 surfaced the full provenance trail in one
  turn.

## [0.1.3] — 2026-04-29 — Hermes-driven Pulse status check + AUTH_NOTES Finding 3

### Added
- `scripts/pulse-status.ts` — standalone helper mirroring the
  `pulse-status-check` skill recipe (used by agents and watchers).
- `hermes-sandbox/AUTH_NOTES.md` Finding 3: enabling the `skills` toolset
  under Pro/Max OAuth pushes the request body past the ~23 KB threshold
  and the call hangs silently. Workaround documented as the API-key
  escape route used in v0.1.4.

## [0.1.2] — 2026-04-29 — ENS Track 1 deliverable

### Added
- **`pulseagent.eth` registered** on Sepolia ENS, owned by the agent EOA
  (`0x30cB…397c`). Five text records (`agentId`, `signerProvider`,
  `pulseHistory`, `description`, `avatar`) bound via the Public Resolver
  `0xE99638b4…E49b5`.
- **`scripts/ens-bind-demo.ts`** — writes the records, resolves them back
  via `pulseProvenanceFromENS()`, then submits Pulse commitment **#8**
  using only ENS-resolved data. No hard-coded `agentId` or
  `signerProvider` in the commit path. Tx
  `0xf36ff751…65ae`.
- **`@pulse/sdk` exports**: `setAgentENSRecords`, `pulseProvenanceFromENS`,
  `resolveAgentByENS` for downstream agents that want to bootstrap from a
  name instead of an env file.

## [0.1.1] — 2026-04-29 — Eth Sepolia migration

### Changed
- The whole stack moves from Base Sepolia to Eth Sepolia (chainId
  11155111) to align with the ENS sponsor track and to put Pulse,
  ERC-8004, the v4 hook, and ENS on the same chain — no cross-chain
  bridging required.

### Verified
- Same deterministic addresses for `Pulse.sol` (deployer + nonce unchanged
  → CREATE collision-free); the v4 hook re-mined a salt against Eth
  Sepolia's PoolManager and landed at `0x274b…c080`.
- Agent ERC-8004 #3906 registered against the canonical IdentityRegistry
  on Eth Sepolia.
- All five validated flows re-run on Eth Sepolia
  (`e2e-commit-reveal`, `exercise-gated-swap`,
  `violation-and-rollback-demo`, `sealed-inference-demo`,
  `phase8-tradingapi-demo`) — each with fresh Etherscan-verifiable tx
  hashes recorded in `deployments/sepolia.json`.

## [0.1.0] — 2026-04-29 — ETHGlobal Open Agents 2026 submission

Initial protocol drop. Tagged so graders can pin to a specific commit.

### Added
- **Contracts deployed on Eth Sepolia.** `Pulse.sol`
  (`0xbe1b…BF34`) and `PulseGatedHook` (`0x274b…c080`) with mocks `pUSD`
  + `pWETH` and a wide-range LP position via `script/Phase2.s.sol`.
- **Six live demos.** `e2e-commit-reveal`, `exercise-gated-swap`,
  `violation-and-rollback-demo`, `sealed-inference-demo`,
  `phase8-tradingapi-demo`, `watch-and-slash`.
- **17 tests passing.** Pulse + PulseGatedHook with the real `Deployers`
  / `HookTest` utilities from v4-core / uniswap-hooks.
- **Hermes integration verified end-to-end.** Agent prompt → Pulse
  contract read on Eth Sepolia, billed against Claude Max OAuth
  subscription. See `hermes-sandbox/AUTH_NOTES.md` for the two
  non-obvious blockers (stale Keychain entry, body-size gate) and the
  fixes baked into `auth.sh`.
- **0G sealed inference end-to-end.** qwen-2.5-7b-instruct reasoning
  hashed into `reasoningCID` and anchored on chain via
  `scripts/sealed-inference-demo.ts`.
- **Architecture-decision-record.** `docs/adr/0001-audit-perimeter.md`
  captures the audit-perimeter thesis and the three load-bearing
  trade-offs: atomic-rollback gap, Anthropic body-size gating, and
  reveal-tx gas budgeting.

[0.5.0]: https://github.com/ss251/ethglobal-openagents/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ss251/ethglobal-openagents/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ss251/ethglobal-openagents/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ss251/ethglobal-openagents/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/ss251/ethglobal-openagents/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/ss251/ethglobal-openagents/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/ss251/ethglobal-openagents/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/ss251/ethglobal-openagents/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ss251/ethglobal-openagents/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ss251/ethglobal-openagents/releases/tag/v0.1.0
