/**
 * Uniswap Trading API helpers for Pulse-bound agent swaps.
 *
 * The intended flow:
 *   1. Agent decides on a swap intent (tokenIn, tokenOut, amount)
 *   2. Agent calls quoteSwap() to get the canonical route + params from the Trading API
 *   3. Agent computes intentHash from the returned PoolKey/SwapParams + a nonce
 *   4. Agent commits via Pulse.commit (separate flow, see ./pulse.ts)
 *   5. Inside the reveal window, agent calls executeFromQuote() OR submits the
 *      swap through a v4 pool wired with PulseGatedHook (hookData = (commitmentId, nonce))
 *
 * Trading API docs: https://docs.uniswap.org/api/trading/overview
 *
 * NOTE: This is a thin wrapper around the public Trading API endpoint.
 * The API requires an API key in the headers (set via env or the `apiKey` arg).
 */

import {type Address, type Hex, type WalletClient, encodeAbiParameters} from "viem";

import type {PoolKey, SwapParams} from "./hook.js";

const TRADE_API_BASE = "https://trade-api.gateway.uniswap.org/v1";

export interface QuoteRequest {
    /// Chain id of tokenIn (the API supports cross-chain in some configs; same-chain is simplest)
    tokenInChainId: number;
    tokenOutChainId: number;
    tokenIn: Address;
    tokenOut: Address;
    /// Raw token amount as a decimal string (the API expects strings, not bigints)
    amount: string;
    /// Wallet address that will sign Permit2 + receive output
    swapper: Address;
    /// 'EXACT_INPUT' or 'EXACT_OUTPUT'
    type?: "EXACT_INPUT" | "EXACT_OUTPUT";
    /// Slippage tolerance in basis points. 50 = 0.5%.
    slippageTolerance?: number;
    /// 'CLASSIC' or 'V4' if you want to constrain protocol
    routingPreference?: "CLASSIC" | "V4" | "BEST_PRICE";
    apiKey?: string;
    fetchImpl?: typeof fetch;
}

export interface QuoteResponse {
    requestId: string;
    quote: {
        chainId: number;
        input: {token: Address; amount: string};
        output: {token: Address; amount: string};
        /// Raw route info (form depends on routingPreference)
        route: unknown;
        /// Permit2 typed-data the swapper must sign before execution
        permitData?: {domain: unknown; types: unknown; values: unknown};
        /// Pre-built tx the caller can broadcast after Permit2 is signed
        transaction?: {to: Address; data: Hex; value: string; gasLimit: string};
    };
    /// When the routing preference returns a v4-native quote, the API includes the
    /// canonical PoolKey + SwapParams the hook expects. We extract these for hashing.
    v4Encoding?: {poolKey: PoolKey; swapParams: SwapParams};
}

/// Fetch a quote from the Trading API. Caller is responsible for nonce / Permit2
/// signing / broadcasting. Pulse-bound agents commit BEFORE calling this in
/// production — for the reference scenario we quote first to get the canonical
/// (PoolKey, SwapParams) bytes, then commit, then execute.
export async function quoteSwap(req: QuoteRequest): Promise<QuoteResponse> {
    const fetcher = req.fetchImpl ?? fetch;
    const body = {
        tokenInChainId: req.tokenInChainId,
        tokenOutChainId: req.tokenOutChainId,
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amount: req.amount,
        swapper: req.swapper,
        type: req.type ?? "EXACT_INPUT",
        slippageTolerance: req.slippageTolerance ?? 50,
        routingPreference: req.routingPreference ?? "BEST_PRICE"
    };

    const apiKey = req.apiKey ?? process.env.UNISWAP_TRADING_API_KEY;
    if (!apiKey) throw new Error("Trading API key missing — set UNISWAP_TRADING_API_KEY or pass apiKey");

    const res = await fetcher(`${TRADE_API_BASE}/quote`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": apiKey
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => "<no body>");
        throw new Error(`Trading API quote failed: ${res.status} ${txt}`);
    }

    return (await res.json()) as QuoteResponse;
}

/// Sign Permit2 typed data + broadcast the prebuilt swap transaction.
/// For Pulse-bound flows: ensure Pulse.commit landed BEFORE calling this OR submit
/// through a v4 pool wired with PulseGatedHook so the hook reveals atomically.
export async function executeFromQuote(
    wallet: WalletClient,
    quote: QuoteResponse
): Promise<Hex> {
    const account = wallet.account;
    if (!account) throw new Error("wallet missing account");

    // If the quote requires a Permit2 signature, the caller is responsible for
    // signing the EIP-712 typed data (`quote.quote.permitData`) and submitting
    // a follow-up /swap request to the Trading API to build the final calldata.
    // We don't attempt the EIP-712 sign here because the typed-data shape
    // depends on routingPreference and the exact router being used. See
    // https://docs.uniswap.org/api/trading/integration-guide.
    if (quote.quote.permitData && !quote.quote.transaction) {
        throw new Error(
            "quote requires Permit2 signature + follow-up /swap call to build transaction. " +
            "See https://docs.uniswap.org/api/trading/integration-guide"
        );
    }

    if (!quote.quote.transaction) {
        throw new Error("quote did not include a prebuilt transaction — call /swap to get one");
    }

    return wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: quote.quote.transaction.to,
        data: quote.quote.transaction.data,
        value: BigInt(quote.quote.transaction.value)
    });
}

/// When the agent's intent is bound by Pulse and enforced via PulseGatedHook,
/// the swap goes through the v4 pool directly with `hookData = abi.encode(commitmentId, nonce)`.
/// This helper builds that hookData blob — re-exported here so callers don't
/// need to import from ./hook.ts when working in Trading API land.
export function pulseHookData(commitmentId: bigint, nonce: Hex): Hex {
    return encodeAbiParameters(
        [{type: "uint256"}, {type: "bytes32"}],
        [commitmentId, nonce]
    );
}
