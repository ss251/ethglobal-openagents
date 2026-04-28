import {keccak256, encodePacked, encodeAbiParameters, type Address, type Hex} from "viem";

/// Mirrors the v4 PoolKey struct — five-field tuple in order.
export interface PoolKey {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
}

/// Mirrors the v4 SwapParams struct.
export interface SwapParams {
    zeroForOne: boolean;
    amountSpecified: bigint;
    sqrtPriceLimitX96: bigint;
}

const POOL_KEY_TUPLE = {
    type: "tuple",
    components: [
        {name: "currency0", type: "address"},
        {name: "currency1", type: "address"},
        {name: "fee", type: "uint24"},
        {name: "tickSpacing", type: "int24"},
        {name: "hooks", type: "address"}
    ]
} as const;

const SWAP_PARAMS_TUPLE = {
    type: "tuple",
    components: [
        {name: "zeroForOne", type: "bool"},
        {name: "amountSpecified", type: "int256"},
        {name: "sqrtPriceLimitX96", type: "uint160"}
    ]
} as const;

/// `actionData` is the canonical encoding committed to via Pulse for a v4 swap.
/// Matches PulseGatedHook's recomputation: abi.encode(key, params).
export function encodeSwapAction(key: PoolKey, params: SwapParams): Hex {
    return encodeAbiParameters(
        [POOL_KEY_TUPLE, SWAP_PARAMS_TUPLE],
        [key, params]
    );
}

/// Computes the intentHash that Pulse.commit + PulseGatedHook agree on.
/// keccak256(abi.encodePacked(nonce, actionData)).
export function computeIntentHash(nonce: Hex, actionData: Hex): Hex {
    return keccak256(encodePacked(["bytes32", "bytes"], [nonce, actionData]));
}

/// Convenience: intentHash for a swap intent in one call.
export function intentHashForSwap(nonce: Hex, key: PoolKey, params: SwapParams): Hex {
    return computeIntentHash(nonce, encodeSwapAction(key, params));
}

/// Produces the `hookData` payload PulseGatedHook decodes:
/// abi.encode(uint256 commitmentId, bytes32 nonce).
export function encodeHookData(commitmentId: bigint, nonce: Hex): Hex {
    return encodeAbiParameters(
        [{type: "uint256"}, {type: "bytes32"}],
        [commitmentId, nonce]
    );
}
