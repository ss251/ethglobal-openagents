/**
 * 0G Galileo testnet chain helper.
 *
 * The viem `chains` package doesn't ship 0G yet; we define it inline.
 * Source: 0G docs (https://docs.0g.ai/developer-hub/testnet/testnet-overview).
 *
 * Note: chainId is **16602** as returned by the live RPC, not 16601 from
 * older docs. Verified 2026-04-29 via eth_chainId on
 * https://evmrpc-testnet.0g.ai.
 */

import {defineChain} from "viem";

export const zgGalileo = defineChain({
    id: 16602,
    name: "0G Galileo Testnet",
    nativeCurrency: {name: "OG", symbol: "OG", decimals: 18},
    rpcUrls: {
        default: {http: ["https://evmrpc-testnet.0g.ai"]}
    },
    blockExplorers: {
        default: {
            name: "0G Chainscan",
            url: "https://chainscan-galileo.0g.ai"
        }
    },
    testnet: true
});

export const ZG_STORAGE_INDEXER = "https://indexer-storage-testnet-turbo.0g.ai";
export const ZG_FAUCET = "https://faucet.0g.ai/";
