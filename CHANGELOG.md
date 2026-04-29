# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

GitHub Releases mirror this file; see
<https://github.com/ss251/ethglobal-openagents/releases> for downloadable
archives at each tag.

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

[0.3.0]: https://github.com/ss251/ethglobal-openagents/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ss251/ethglobal-openagents/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/ss251/ethglobal-openagents/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/ss251/ethglobal-openagents/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/ss251/ethglobal-openagents/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/ss251/ethglobal-openagents/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ss251/ethglobal-openagents/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ss251/ethglobal-openagents/releases/tag/v0.1.0
