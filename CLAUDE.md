# Project conventions for AI assistants working in this repo

## What this is
`Pulse.sol` — galaxy-brain-resistant agent commitments. Time-locked commit-reveal
with TEE-attested reasoning. ERC-8004 reputation hooks. Optional Uniswap v4 hook
gating swaps by Pulse commitments. Ships with `pulse-skills` — a drop-in
agent-agnostic skills bundle (`packages/plugins/pulse-skills/`) so any agent
framework (OpenClaw, Hermes, ElizaOS, LangChain, custom) can plug into Pulse
via `npx skills add thescoho/ethglobal-openagents` or `/plugin install`.

## Toolchain
- Solidity 0.8.26, EVM Cancun, via_ir on
- Foundry for contracts/tests
- bun workspaces for `packages/sdk` and `packages/agent`
- viem for TS clients

## Skill index
Skills live under `.claude/skills/`. Top-level entries are canonical
(symlinks into the skill submodules where applicable).

| Skill | When to use |
|---|---|
| `v4-hook-generator` | Before writing or changing `contracts/hooks/*.sol`. Decision table for hook type + permissions + libs. |
| `v4-security-foundations` | Before deploying a hook. Audit checklist + NoOp / delta-accounting traps. Always run alongside hook generation. |
| `swap-integration` | Wiring agent code to Uniswap Trading API or Universal Router. |
| `pay-with-any-token` | x402 + MPP payment flows that route through Uniswap swaps. |
| `v4-sdk-integration` | TypeScript v4 SDK (PoolKey/SwapParams encoding) for the agent or SDK package. |
| `swap-planner`, `liquidity-planner` | Planning swap or LP intents before commit. |
| `viem-integration` | viem patterns the SDK should follow. |
| `solidity-auditor` (Pashov) | Self-audit pass on contract changes before commit. |
| `pashov-x-ray` | Diff-level audit when refactoring contracts. |
| `0g-compute-skills` | 0G Compute SDK — `processResponse`, broker setup, sealed inference. |
| `eth-security`, `eth-gas`, `eth-audit`, `eth-testing`, `eth-defi`, `eth-standards`, `eth-wallets`, `eth-openclaw` | Topic-specific patterns from austintgriffith/ethskills. |
| `pulse-skills` (`packages/plugins/pulse-skills/`) | Built in this repo — bind any agent to its own pre-decisions via Pulse. Skills: `pulse-commit`, `pulse-reveal`, `pulse-status-check`, `pulse-gated-swap`, `sealed-inference-with-pulse`. |

## Working rules
- Use OpenZeppelin standardized contracts wherever possible (`ECDSA`, `SignatureChecker`, `MessageHashUtils`, `ReentrancyGuard`).
- Use ERC-8004's deployed registries; never redeploy them. Canonical addresses live in `script/Deploy.s.sol`.
- For v4 hooks, inherit `BaseHook` from `@openzeppelin/uniswap-hooks` and follow `v4-security-foundations`.
- All cryptography goes through libraries — never roll your own.
- Tests use mocks for ERC-8004 unit tests; v4 tests use the real `Deployers` + `HookTest` utilities from v4-core / uniswap-hooks.

## Run
```bash
forge build
forge test
forge test -vv --match-test test_specific
```

## Skill activation
Skills are auto-discovered by Claude Code via SKILL.md frontmatter. Reference
the relevant skill explicitly in PR descriptions and commit messages where it
informed the change.
