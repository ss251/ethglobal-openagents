/**
 * Trading-API → Pulse roundtrip demo.
 *
 * Demonstrates the production pattern an autonomous trading agent follows:
 *
 *   1. Pull a real quote from the Uniswap Trading API (mainnet WETH → USDC)
 *      to ground the decision in actual market state.
 *   2. Hash (tokenIn, tokenOut, amountIn, expectedOut) into an intentHash
 *      so the commitment binds to specific economic parameters.
 *   3. Hash the entire quote payload into reasoningCID — anyone can later
 *      re-pull (or recompute from the requestId) the canonical quote and
 *      verify it matches what the agent committed to.
 *   4. Commit on Eth Sepolia via Pulse.
 *
 * Why this is a meaningful demo: agents in production quote first, decide,
 * then execute. Pulse turns "decide" into a public, time-bounded artifact
 * that can be verified (and slashed) downstream.
 *
 * Run: bun run scripts/phase8-tradingapi-demo.ts
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    encodeAbiParameters,
    encodeFunctionData,
    encodePacked,
    toHex,
    type Address,
    type Hex
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";
import {randomBytes} from "node:crypto";

import {quoteSwap, type QuoteResponse} from "../packages/sdk/src/trading.js";

const RPC = process.env.SEPOLIA_RPC_URL!;
const PULSE = process.env.PULSE_ADDRESS! as Address;
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY! as Hex;
const TEE_KEY = process.env.DEMO_TEE_SIGNER_KEY! as Hex;
const AGENT_ID = BigInt(process.env.AGENT_ID!);

const agent = privateKeyToAccount(AGENT_KEY);
const tee = privateKeyToAccount(TEE_KEY);

const publicClient = createPublicClient({chain: sepolia, transport: http(RPC)});
const walletClient = createWalletClient({account: agent, chain: sepolia, transport: http(RPC)});

const PULSE_ABI = [
    {
        type: "function",
        name: "commit",
        stateMutability: "nonpayable",
        inputs: [
            {name: "agentId", type: "uint256"},
            {name: "intentHash", type: "bytes32"},
            {name: "reasoningCID", type: "bytes32"},
            {name: "executeAfter", type: "uint64"},
            {name: "revealWindow", type: "uint64"},
            {name: "signerProvider", type: "address"},
            {name: "sealedSig", type: "bytes"}
        ],
        outputs: [{name: "id", type: "uint256"}]
    }
] as const;

// Mainnet liquid pair — Trading API has thin/no testnet routes
const ETHEREUM_MAINNET = 1;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

interface CommitmentBundle {
    intentHash: Hex;
    reasoningCID: Hex;
    nonce: Hex;
    actionData: Hex;
    quote: NormalizedQuote;
}

interface NormalizedQuote {
    requestId: string;
    routing: string;
    chainId: number;
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    expectedOut: bigint;
    minOut: bigint;
    raw: QuoteResponse;
}

/// Trading API returns one of several routing shapes (DUTCH_V2, DUTCH_V3,
/// CLASSIC, BRIDGE, …). Normalize them down to the four numbers Pulse cares about.
function normalizeQuote(q: any): NormalizedQuote {
    const routing = q.routing as string;
    let tokenIn: Address, tokenOut: Address, amountIn: bigint, expectedOut: bigint, minOut: bigint;

    if (q.permitData?.values?.permitted && q.permitData?.values?.witness?.baseOutputs) {
        // DUTCH_V2 / V3 (UniswapX) — values come from the Permit2 typed-data.
        const inp = q.permitData.values.permitted;
        const out = q.permitData.values.witness.baseOutputs[0];
        tokenIn = inp.token as Address;
        tokenOut = out.token as Address;
        amountIn = BigInt(inp.amount);
        expectedOut = BigInt(out.startAmount);
        minOut = BigInt(out.endAmount);
    } else if (q.quote?.input && q.quote?.output) {
        // CLASSIC v3 / v4
        tokenIn = q.quote.input.token as Address;
        tokenOut = q.quote.output.token as Address;
        amountIn = BigInt(q.quote.input.amount);
        expectedOut = BigInt(q.quote.output.amount);
        minOut = (expectedOut * 9950n) / 10000n; // 50bp tolerance
    } else {
        throw new Error(`unrecognized quote shape (routing=${routing})`);
    }

    return {
        requestId: q.requestId,
        routing,
        chainId: q.permitData?.domain?.chainId ?? q.quote?.chainId,
        tokenIn,
        tokenOut,
        amountIn,
        expectedOut,
        minOut,
        raw: q
    };
}

/// intentHash binds the agent to a specific (tokenIn, tokenOut, amountIn, minOut) tuple.
/// The action layer downstream (whether a hook, a wallet, or a relay) verifies
/// that whatever it's about to execute matches these bytes.
function buildIntent(q: NormalizedQuote, nonce: Hex): {intentHash: Hex; actionData: Hex} {
    const actionData = encodeAbiParameters(
        [
            {name: "tokenIn", type: "address"},
            {name: "tokenOut", type: "address"},
            {name: "amountIn", type: "uint256"},
            {name: "minOut", type: "uint256"}
        ],
        [q.tokenIn, q.tokenOut, q.amountIn, q.minOut]
    );
    const intentHash = keccak256(encodePacked(["bytes32", "bytes"], [nonce, actionData]));
    return {intentHash, actionData};
}

/// reasoningCID is a content hash over the canonical quote payload. Anyone
/// can re-pull (via requestId) and confirm the hash matches.
function hashQuoteReasoning(q: NormalizedQuote): Hex {
    const blob = JSON.stringify({
        requestId: q.requestId,
        routing: q.routing,
        chainId: q.chainId,
        tokenIn: q.tokenIn,
        tokenOut: q.tokenOut,
        amountIn: q.amountIn.toString(),
        expectedOut: q.expectedOut.toString(),
        minOut: q.minOut.toString()
    });
    return keccak256(toHex(blob));
}

async function buildCommitmentBundle(): Promise<CommitmentBundle> {
    console.log("→ Fetching real quote from Uniswap Trading API (mainnet WETH→USDC)…");
    const raw = await quoteSwap({
        tokenInChainId: ETHEREUM_MAINNET,
        tokenOutChainId: ETHEREUM_MAINNET,
        tokenIn: WETH,
        tokenOut: USDC,
        amount: "1000000000000000000", // 1 WETH
        swapper: agent.address,
        type: "EXACT_INPUT",
        slippageTolerance: 50,
        routingPreference: "BEST_PRICE"
    });

    const quote = normalizeQuote(raw);
    const expectedHuman = Number(quote.expectedOut) / 1e6; // USDC is 6 decimals
    const minHuman = Number(quote.minOut) / 1e6;
    console.log(`  requestId:          ${quote.requestId}`);
    console.log(`  routing:            ${quote.routing}`);
    console.log(`  amountIn:           1.0 WETH`);
    console.log(`  expectedOut:        ${expectedHuman.toFixed(2)} USDC`);
    console.log(`  minOut (slippage):  ${minHuman.toFixed(2)} USDC`);

    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    const {intentHash, actionData} = buildIntent(quote, nonce);
    const reasoningCID = hashQuoteReasoning(quote);

    return {intentHash, reasoningCID, nonce, actionData, quote};
}

async function commitToQuote(bundle: CommitmentBundle): Promise<{commitmentId: bigint; commitTx: Hex}> {
    const block = await publicClient.getBlock({blockTag: "latest"});
    const executeAfter = block.timestamp + 30n;
    const revealWindow = 600n;

    const payload = keccak256(
        encodeAbiParameters(
            [{type: "uint256"}, {type: "bytes32"}, {type: "bytes32"}, {type: "uint64"}],
            [AGENT_ID, bundle.intentHash, bundle.reasoningCID, executeAfter]
        )
    );
    const sealedSig = await tee.signMessage({message: {raw: payload}});

    const data = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "commit",
        args: [
            AGENT_ID,
            bundle.intentHash,
            bundle.reasoningCID,
            executeAfter,
            revealWindow,
            tee.address,
            sealedSig
        ]
    });

    const commitTx = await walletClient.sendTransaction({to: PULSE, data});
    const receipt = await publicClient.waitForTransactionReceipt({hash: commitTx});

    let commitmentId: bigint | null = null;
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== PULSE.toLowerCase()) continue;
        if (log.topics[0]) commitmentId = BigInt(log.topics[1]!);
        if (commitmentId) break;
    }
    if (!commitmentId) throw new Error("Committed event not found in receipt");

    return {commitmentId, commitTx};
}

async function main() {
    console.log("══════════════════════════════════════════════════════════════════");
    console.log(" Phase 8 — Trading API → Pulse roundtrip");
    console.log("══════════════════════════════════════════════════════════════════");
    console.log(`  Pulse:  ${PULSE}`);
    console.log(`  Agent:  ${agent.address} (id=${AGENT_ID})`);
    console.log(`  Quote:  Trading API (Ethereum mainnet, real liquidity)`);
    console.log(`  Commit: Eth Sepolia\n`);

    const bundle = await buildCommitmentBundle();
    console.log(`\n  intentHash:    ${bundle.intentHash}`);
    console.log(`  reasoningCID:  ${bundle.reasoningCID}`);
    console.log(`  nonce:         ${bundle.nonce}`);
    console.log(`  actionData:    ${bundle.actionData.slice(0, 80)}…`);

    console.log("\n→ Committing on Eth Sepolia…");
    const {commitmentId, commitTx} = await commitToQuote(bundle);
    console.log(`  commit tx:     ${commitTx}`);
    console.log(`  commitmentId:  ${commitmentId}`);

    console.log("\n══════════════════════════════════════════════════════════════════");
    console.log("Done. The agent has cryptographically locked itself to a swap whose");
    console.log("expected economics match a Trading API quote pulled at commit time.");
    console.log("Downstream execution layers (gated pool, wallet, relayer) verify the");
    console.log("intentHash matches what they're about to do — divergence → slash.");
    console.log("══════════════════════════════════════════════════════════════════");
}

main().catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
});
