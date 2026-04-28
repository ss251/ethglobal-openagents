/**
 * Reference scenario: a Pulse-bound autonomous swap.
 *
 * The agent:
 *  1. Resolves its own identity via ENS (forge.pulseagent.eth or similar)
 *  2. Calls 0G Compute for sealed-inference reasoning about the swap
 *  3. Quotes the swap via the Uniswap Trading API
 *  4. Computes the canonical intent hash from the V4-encoded (PoolKey, SwapParams)
 *  5. Commits the hash + sealed reasoning onchain via Pulse
 *  6. (Inside the reveal window) submits the swap to a v4 pool wired with
 *     PulseGatedHook, attaching hookData = abi.encode(commitmentId, nonce).
 *     The hook atomically reveals the commitment and lets the swap proceed —
 *     OR reverts if the params don't match the committed hash.
 *
 * This file is meant to be runnable: fill in env (see env.example) and run
 *   bun run demo:swap
 *
 * Replace the placeholder swap parameters with real testnet token addresses
 * before invoking on Sepolia.
 */

import {createPublicClient, createWalletClient, http, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {randomBytes} from "node:crypto";

import {
    commitIntent,
    encodeSwapAction,
    intentHashForSwap,
    pulseHookData,
    quoteSwap,
    fetchSealedReasoning,
    pulseProvenanceFromENS,
    type SealedReasoning,
    type PoolKey,
    type SwapParams
} from "@pulse/sdk";

interface ScenarioConfig {
    rpcUrl: string;
    pulseAddress: Address;
    poolManager: Address;
    /// ENS subname the agent owns and resolves to its provenance. Falls back
    /// to direct env values if ENS resolution is unavailable.
    agentENSName?: string;
    /// Override fallback values when ENS isn't available
    fallback: {
        agentId: bigint;
        agentPrivateKey: Hex;
        signerProvider: Address;
    };
    /// 0G broker config — production path
    zgBrokerUrl: string;
    zgChatId: string;
    zgModel: string;
    /// Swap intent
    swap: {
        tokenIn: Address;
        tokenOut: Address;
        amountIn: string; // raw amount as decimal string
    };
    /// Pulse window
    executeAfterSeconds: bigint;
    revealWindowSeconds: bigint;
    /// Off-chain reasoning content-address (CID, IPFS hash, etc.)
    reasoningCID: Hex;
}

export async function runPulseBoundSwap(cfg: ScenarioConfig) {
    const publicClient = createPublicClient({chain: baseSepolia, transport: http(cfg.rpcUrl)});

    // 1. Resolve agent provenance — prefer ENS, fall back to env
    let agentId: bigint;
    let agentAddress: Address;
    let signerProvider: Address;
    if (cfg.agentENSName) {
        try {
            const provenance = await pulseProvenanceFromENS({
                client: publicClient,
                name: cfg.agentENSName
            });
            agentId = provenance.agentId;
            agentAddress = provenance.address;
            signerProvider = provenance.signerProvider;
            console.log(`[1/6] Agent identity resolved via ENS: ${cfg.agentENSName}`);
            console.log(`       agentId=${agentId}, address=${agentAddress}`);
        } catch {
            console.warn(`[1/6] ENS resolution failed for ${cfg.agentENSName}; falling back to env values`);
            agentId = cfg.fallback.agentId;
            agentAddress = privateKeyToAccount(cfg.fallback.agentPrivateKey).address;
            signerProvider = cfg.fallback.signerProvider;
        }
    } else {
        agentId = cfg.fallback.agentId;
        agentAddress = privateKeyToAccount(cfg.fallback.agentPrivateKey).address;
        signerProvider = cfg.fallback.signerProvider;
        console.log(`[1/6] Agent identity loaded from env (no ENS configured)`);
    }

    // 2. Pull TEE-signed reasoning from 0G broker
    let reasoning: SealedReasoning;
    try {
        reasoning = await fetchSealedReasoning({
            brokerUrl: cfg.zgBrokerUrl,
            chatId: cfg.zgChatId,
            model: cfg.zgModel,
            signerAddress: signerProvider
        });
        console.log(`[2/6] Sealed reasoning pulled from 0G broker (${reasoning.text.length} chars)`);
    } catch (err) {
        throw new Error(
            `Failed to fetch sealed reasoning from 0G. ` +
            `For demo, swap to a pre-captured replay: load JSON of a prior 0G response and use those bytes. ` +
            `(${(err as Error).message})`
        );
    }

    // 3. Quote the swap via Uniswap Trading API (V4-routed for hook compatibility)
    const quote = await quoteSwap({
        tokenInChainId: 84532, // Base Sepolia
        tokenOutChainId: 84532,
        tokenIn: cfg.swap.tokenIn,
        tokenOut: cfg.swap.tokenOut,
        amount: cfg.swap.amountIn,
        swapper: agentAddress,
        type: "EXACT_INPUT",
        slippageTolerance: 50, // 0.5%
        routingPreference: "V4"
    });
    console.log(`[3/6] Trading API quote received (requestId=${quote.requestId})`);

    if (!quote.v4Encoding) {
        throw new Error(
            "Trading API returned a non-V4 route. Pulse-gated swaps require V4 encoding. " +
            "Either narrow tokens to a known V4 pool, or set routingPreference: 'V4' explicitly."
        );
    }

    const poolKey: PoolKey = quote.v4Encoding.poolKey;
    const swapParams: SwapParams = quote.v4Encoding.swapParams;

    // 4. Compute the canonical intent hash. Same encoding the hook recomputes.
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    const actionData = encodeSwapAction(poolKey, swapParams);
    const intentHash = intentHashForSwap(nonce, poolKey, swapParams);
    console.log(`[4/6] Intent hash computed: ${intentHash}`);

    // 5. Commit onchain via Pulse
    const wallet = createWalletClient({
        account: privateKeyToAccount(cfg.fallback.agentPrivateKey),
        chain: baseSepolia,
        transport: http(cfg.rpcUrl)
    });
    const executeAfter = BigInt(Math.floor(Date.now() / 1000)) + cfg.executeAfterSeconds;

    const commitTx = await commitIntent(wallet, cfg.pulseAddress, {
        agentId,
        actionData,
        nonce,
        reasoning,
        reasoningCID: cfg.reasoningCID,
        executeAfter,
        revealWindow: cfg.revealWindowSeconds
    });
    console.log(`[5/6] Pulse.commit submitted: ${commitTx}`);

    // 6. Build hookData for the v4 swap. The submitter (agent or anyone with
    // the nonce) attaches this to the swap call when going through a pool
    // wired with PulseGatedHook.
    //
    // Actual swap submission to PoolManager.swap is left as the integration
    // step — it depends on whether the caller uses PoolSwapTest, the Universal
    // Router, or a custom router. The hookData blob is what binds Pulse to v4.
    const commitmentId = await readCommitmentIdFromCommitTx(publicClient, commitTx, cfg.pulseAddress);
    const hookData = pulseHookData(commitmentId, nonce);

    console.log(`[6/6] Pulse-bound swap ready.`);
    console.log(`       commitmentId: ${commitmentId}`);
    console.log(`       nonce:        ${nonce}`);
    console.log(`       hookData:     ${hookData}`);
    console.log(`       Submit to PoolManager.swap(poolKey, swapParams, hookData) inside the reveal window.`);

    return {commitmentId, nonce, intentHash, hookData, poolKey, swapParams};
}

async function readCommitmentIdFromCommitTx(
    client: ReturnType<typeof createPublicClient>,
    txHash: Hex,
    pulseAddress: Address
): Promise<bigint> {
    const receipt = await client.waitForTransactionReceipt({hash: txHash});
    // Pulse emits Committed(uint256 indexed id, uint256 indexed agentId, ...)
    // The id is in the first indexed topic after the event signature topic.
    const log = receipt.logs.find(
        (l) => l.address.toLowerCase() === pulseAddress.toLowerCase() && (l.topics?.length ?? 0) >= 3
    );
    if (!log || !log.topics[1]) {
        throw new Error("Could not decode commitmentId from Committed event");
    }
    return BigInt(log.topics[1]);
}

// ─── Entrypoint when run directly via `bun run demo:swap` ───────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
    const cfg: ScenarioConfig = {
        rpcUrl: process.env.BASE_SEPOLIA_RPC_URL!,
        pulseAddress: process.env.PULSE_ADDRESS! as Address,
        poolManager: process.env.POOL_MANAGER! as Address,
        agentENSName: process.env.AGENT_ENS_NAME,
        fallback: {
            agentId: BigInt(process.env.AGENT_ID ?? "0"),
            agentPrivateKey: process.env.AGENT_PRIVATE_KEY! as Hex,
            signerProvider: process.env.ZG_SIGNER_ADDRESS! as Address
        },
        zgBrokerUrl: process.env.ZG_BROKER_URL!,
        zgChatId: process.env.ZG_CHAT_ID ?? "",
        zgModel: process.env.ZG_MODEL ?? "deepseek-reasoner",
        swap: {
            tokenIn: (process.env.DEMO_TOKEN_IN ?? "0x0000000000000000000000000000000000000000") as Address,
            tokenOut: (process.env.DEMO_TOKEN_OUT ?? "0x0000000000000000000000000000000000000000") as Address,
            amountIn: process.env.DEMO_AMOUNT_IN ?? "1000000000000000" // 0.001 token
        },
        executeAfterSeconds: 60n, // 1 min lock
        revealWindowSeconds: 3600n, // 1 hr window
        reasoningCID: (process.env.DEMO_REASONING_CID ?? `0x${"0".repeat(64)}`) as Hex
    };

    runPulseBoundSwap(cfg)
        .then((res) => {
            console.log("\nDone. Pulse-bound swap is committed; submit the swap inside the window.");
            console.log(JSON.stringify(res, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
        })
        .catch((err) => {
            console.error("\nScenario failed:", err);
            process.exit(1);
        });
}
