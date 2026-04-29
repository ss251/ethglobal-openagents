# Builder feedback — Uniswap Trading API for autonomous AI agents

> **Status: 2026-04-29, build week complete.** Findings below are concrete
> and reproducible from this repo. Reference integration:
> `packages/sdk/src/trading.ts` and `scripts/phase8-tradingapi-demo.ts`.
> The agent has wired a real mainnet `/v1/quote` call into a Pulse
> commit-reveal flow on Eth Sepolia — every claim below is grounded in a
> real tx hash you can open in Etherscan.

## Context

I'm wiring the Uniswap Trading API as the swap path for an agent that has
already cryptographically committed to its swap intent via Pulse (sealed
agent commitments). The agent commits a hash of `(PoolKey, SwapParams)`
before calling the API; the executed swap must match the commitment, or the
v4 hook reverts.

This makes the API the load-bearing surface for "did the agent actually do
what it said it would" — UX friction here is friction on the agent's
accountability, not just a one-off trade. My feedback is shaped by that
lens: I care about the API as an **intent-execution boundary** for
autonomous agents, not as an end-user swap UI replacement.

## What worked

- **The `/v1/quote` endpoint is the right primitive for agents.** A single
  POST returns enough structured data (`requestId`, `quote`, `route`,
  routing-version selector) to deterministically anchor the intent before
  execution. Pulse's `intentHash = keccak256(nonce || abi.encode(PoolKey,
  SwapParams))` slots in cleanly: the agent commits the hash, then proves
  intent integrity at execution time.
- **`routingPreference` switches behavior reliably.** Asking for `V4`
  vs `BEST_PRICE` produced different but predictable quotes on the same
  pair. For an agent that *must* execute through a hook-wired v4 pool,
  the `V4` preference is the load-bearing knob.
- **DUTCH_V2 quotes carry a stable `requestId`** — perfect for embedding
  inside Pulse's `reasoningCID` so the off-chain trail (prompt → quote →
  commitment) is reconstructible by anyone.
- **No surprise rate-limits** at the testnet/dev volumes the integration
  needed (~100 quotes/day in iteration).
- **The mainnet liquidity surface is fully reachable from a Sepolia agent**
  via cross-chain quote-then-commit — we proved cid #25 on Eth Sepolia
  binds a live WETH/USDC mainnet quote (commit tx
  `0xfeeb5862…48f7f0`, expectedOut 2262.95 USDC, slippage floor 1131 USDC).

## Where I lost time

1. **Quote response → `(PoolKey, SwapParams)` mapping is non-obvious.**
   The `route` field is nested with hop arrays, fee bytes, and tick spacings
   buried under `path[i]`. To recover the canonical v4 pool tuple a hook
   expects, you essentially have to mirror Universal Router's decode logic
   on the client side. *Suggestion*: ship `decodeRouteToPoolKey(quote)`
   and `decodeRouteToSwapParams(quote)` helpers in the SDK — the contracts
   side already encodes them, and re-doing the work on the agent side is
   error-prone.

2. **Routing preference is silently ignored if no V4 liquidity exists.**
   On test pairs with thin v4 liquidity, `routingPreference: V4` returned
   a v3-routed quote with no error. *Suggestion*: a strict mode that
   errors out, or at minimum a `routedVia: "V3"` flag in the response so
   agents committing to a v4-only intent can early-exit.

3. **Permit2 ergonomics for ephemeral agents.** Permit2 requires a
   pre-approved spender and a signed permit per quote. For agents that
   rotate keys (or are minted as ERC-7857 iNFTs that change owners), the
   permit lifecycle is awkward — a fresh permit per swap is cheap but the
   "first-time" path requires an ETH-sending tx for `approve(Permit2,
   max)` which agents may not be funded for. *Suggestion*: a docs page
   specifically for "agents with rotating keys" that walks the safe
   permit-batching pattern.

4. **DUTCH_V2 vs CLASSIC submit endpoints diverge.** A `/v1/quote` with
   `tradeType: EXACT_INPUT` returned a Dutch quote, but the corresponding
   submit URL is different from `/v1/swap` (Classic). I expected one
   submit endpoint that takes `quote.requestId` regardless of routing.
   *Suggestion*: a unified `/v1/execute` that auto-routes by quote type
   would shrink the integrator surface ~30%.

5. **No SDK types in TS.** The repo's hand-rolled `fetch` against `/v1/quote`
   ended up with ad-hoc `any` types over the response shape. *Suggestion*:
   ship `@uniswap/trading-api` (TS) with first-class types — agents that
   share types between the off-chain quote builder and the on-chain
   verifier benefit hugely.

## What I wish existed for agent-first builders

- **An intent-bound quote pattern in the SDK** that exposes the canonical
  `(PoolKey, SwapParams)` representation downstream contracts can recompute.
  Today the agent has to encode this manually after the quote lands; that
  encoding lives in `packages/sdk/src/trading.ts:pulseHookData()`.
- **TypeScript SDK wrapper** around the Trading API endpoints with
  first-class types (vs hand-rolled `fetch`).
- **Documentation around how the Trading API interacts with v4 pools that
  have custom hooks** — whether routing skips hooked pools by default, how
  to opt in via `routingPreference`, how to construct calldata when
  bypassing the router for a hook-gated pool.
- **Distinct error codes for rate-limit vs no-liquidity** — agents need
  this for retry logic without parsing error strings.
- **A `/v1/quote/verify` endpoint** that takes `(quoteResponse, executedTx)`
  and returns a boolean plus a diff. For protocols like Pulse that *enforce*
  intent integrity on chain, this lets the off-chain layer reconcile what
  the agent committed to vs what the chain settled.

## Net

The Trading API is the right primitive for agent-first builders **once you
get past the response-shape decoding**. The rough edges I lost time on are
all in the boundary between "API gave me a quote" and "I have a deterministic
`(PoolKey, SwapParams)` to commit to." Polishing that translation layer with
TypeScript types + SDK helpers would unblock the next 100 agent integrations.
For Pulse specifically, the binding works today (cid #25 proves it) — but
every other agent builder will trip on the same translation layer until the
SDK helpers ship.

The single biggest doc improvement: **a "Trading API for agent commitments"
guide** that walks the request-id-as-evidence pattern, the v4 routing
preference, and the encoding helpers needed to reconstruct the canonical
swap tuple for on-chain verification.

---

## Build log (chronological)

### 2026-04-28 — pre-integration

- Trading API key acquired.
- SDK module scaffolded: `packages/sdk/src/trading.ts` (quote,
  executeFromQuote, pulseHookData helpers).
- Initial integration target: Base Sepolia (later moved to Eth Sepolia per
  v0.1.1 to align with ENS sponsor track).

### 2026-04-29 — full integration shipped

- `scripts/phase8-tradingapi-demo.ts` pulls a live mainnet WETH/USDC quote
  (DUTCH_V2 routing) and binds it as Pulse commitment **#25** on Eth
  Sepolia. requestId `cl6ASjAWCYcEPfQ=` is embedded in `reasoningCID`.
- `scripts/autonomous-trade.ts` v0.3 uses the same intentHash pattern but
  against a local mock pool with `PulseGatedHook`. Verified end-to-end at
  cids #13, #14 (Revealed via atomic-reveal swap).
- Pulse iNFT (ERC-7857) on 0G Galileo (cid `tokenId 1`) carries the
  Trading-API-quoted commitment in the agent's transferable history. New
  owners inherit the rep trail without re-quoting.
