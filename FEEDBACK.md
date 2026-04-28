# Builder feedback — Uniswap Trading API for autonomous AI agents

> **Status as of 2026-04-28 (event day 4 of 12)**: integration in progress.
> This file will be updated with concrete findings as the Trading API is wired
> into Pulse over Days 1–3 of build week. Sections below are the structure for
> the final feedback artifact required by the Open Agents Uniswap Trading API
> prize track. Empty sections are explicitly marked TBD until the integration
> work has been done.

## Context

I am wiring the Uniswap Trading API as the swap path for an agent that has
already cryptographically committed to its swap intent via Pulse (sealed
agent commitments). The agent commits a hash of `(PoolKey, SwapParams)`
before calling the API; the executed swap must match the commitment, or the
v4 hook reverts.

This makes the API the load-bearing surface for "did the agent actually do
what it said it would" — UX friction here is friction on the agent's
accountability, not just on a one-off trade. My feedback is shaped by that
specific lens: I care about the API as an **intent-execution boundary** for
autonomous agents, not as an end-user swap UI replacement.

Reference integration: `packages/sdk/src/trading.ts` in this repo.

## What worked

*(To be filled in after Day 1–2 integration work. Sections will be
populated with concrete findings — quote shape ergonomics, Permit2 fit for
agent flows, routing preference behavior, doc clarity for first
integration, etc.)*

- TBD
- TBD
- TBD

## Where I lost time

*(To be filled in with reproducible friction. Each item will include: what
I tried, what failed or surprised me, the doc page that should have
prevented it, and a one-line suggestion for closing the gap.)*

- TBD
- TBD
- TBD

## What I wish existed for agent-first builders

*(To be filled in. Areas I expect to write up based on the project's
integration shape:)*

- An intent-bound swap pattern in the SDK that exports the canonical
  `(PoolKey, SwapParams)` representation downstream contracts can recompute.
- TypeScript SDK wrapper around the Trading API endpoints with first-class
  types (vs hand-rolled `fetch`).
- Documentation around how the Trading API interacts with v4 pools that
  have custom hooks (whether routing skips hooked pools, how to opt in,
  how to construct calldata when bypassing the router).
- Distinct error codes for rate-limit vs no-liquidity (matters for agent
  retry logic).

These are hypotheses based on the integration shape, not yet validated.
Final form will be data-driven.

## Net (final write-up)

*(To be filled in at end of build week. Will summarize: where the API is the
right primitive for agent-first builders, where it isn't, and the single
biggest doc/SDK improvement that would unblock the next 100 agent
integrations.)*

---

## Build log (chronological)

### 2026-04-28 — pre-integration
- Trading API key acquired: TBD
- SDK module scaffolded: `packages/sdk/src/trading.ts` (quote, executeFromQuote, pulseHookData helpers)
- Integration test target: testnet swap on Base Sepolia, agent commits via Pulse before calling `/quote`, executes through PulseGatedHook-wired pool

### 2026-04-29 — Day 1 work
*(TBD — fill in actual findings as work progresses)*

### 2026-04-30 — Day 2 work
*(TBD)*

### 2026-05-01 — Day 3 work
*(TBD)*
