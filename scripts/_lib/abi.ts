/**
 * Shared ABI fragments used by every Pulse-bound script. Single source of
 * truth — keeps autonomous-trade.ts, force-drift.ts, pulse-retry.ts, and
 * pulse-introspect.ts in lockstep.
 */

import {parseAbi} from "viem";

export const PULSE_ABI = parseAbi([
    "function commit(uint256 agentId, bytes32 intentHash, bytes32 reasoningCID, uint64 executeAfter, uint64 revealWindow, address signerProvider, bytes sealedSig) returns (uint256 id)",
    "function reveal(uint256 id, bytes32 nonce, bytes actionData)",
    "function getStatus(uint256 id) view returns (uint8)",
    "function getCommitment(uint256 id) view returns (uint256 agentId, address principal, uint64 commitTime, uint64 executeAfter, uint64 revealDeadline, uint8 status, bytes32 intentHash, bytes32 reasoningCID, address signerProvider)",
    "event Committed(uint256 indexed id, uint256 indexed agentId, bytes32 intentHash, bytes32 reasoningCID, uint64 executeAfter, uint64 revealWindow, address signerProvider)",
    "event Revealed(uint256 indexed id, address indexed revealer, bytes32 actionDataHash)",
    "event Violated(uint256 indexed id, address indexed revealer, bytes32 expectedHash, bytes32 actualHash)"
]);

export const ERC20_ABI = parseAbi([
    "function mint(address to, uint256 amount)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)"
]);

export const SWAP_ROUTER_ABI = parseAbi([
    "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
    "struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }",
    "struct TestSettings { bool takeClaims; bool settleUsingBurn; }",
    "function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) returns (int256)"
]);

export const STATUS_LABELS = ["Pending", "Revealed", "Violated", "Expired"] as const;
export type StatusLabel = (typeof STATUS_LABELS)[number];

// v4 sqrtPrice bounds — usable as the no-slippage caps for sweep swaps.
export const MIN_SQRT_PRICE = 4295128740n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341n;
