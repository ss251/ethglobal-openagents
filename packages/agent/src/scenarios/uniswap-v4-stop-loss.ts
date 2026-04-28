/**
 * End-to-end Pulse + Uniswap v4 stop-loss scenario.
 *
 * 1. Agent reads market state, decides on a sell-if-volatility-spikes intent.
 * 2. Agent calls 0G Compute (sealed inference) for reasoning. The TEE-signed
 *    response binds the reasoning hash to (agentId, intentHash, executeAfter).
 * 3. Agent commits to Pulse with the swap intent hash.
 * 4. Sometime in the [executeAfter, revealDeadline) window, the agent (or a
 *    third party with the nonce) submits the swap to a v4 pool wired with
 *    PulseGatedHook. The hook validates the commitment and lets the swap
 *    through.
 *
 * This is reference code — replace the inputs with real wallet, RPC, and
 * 0G provider data before running. It does not execute on import.
 */

import {createWalletClient, http, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";

import {
    commitIntent,
    intentHashForSwap,
    encodeHookData,
    fetchSealedReasoning,
    type PoolKey,
    type SwapParams,
    type SealedReasoning
} from "@pulse/sdk";

interface ScenarioConfig {
    agentPrivateKey: Hex;
    rpcUrl: string;
    pulseAddress: Address;
    poolKey: PoolKey;
    /// 0G Compute service the agent has acknowledged
    zgBrokerUrl: string;
    zgChatId: string;
    zgModel: string;
    zgSignerAddress: Address;
    /// Off-chain ID under which Pulse identifies this agent (ERC-8004 token ID)
    agentId: bigint;
}

export async function runStopLoss(cfg: ScenarioConfig) {
    const account = privateKeyToAccount(cfg.agentPrivateKey);
    const wallet = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(cfg.rpcUrl)
    });

    // 1. Decide swap params based on agent's risk model (placeholder values).
    const params: SwapParams = {
        zeroForOne: true,
        amountSpecified: -1_000_000_000_000_000n, // 0.001 token0 exactIn
        sqrtPriceLimitX96: 4295128740n // MIN_PRICE_LIMIT for zeroForOne
    };

    // 2. Pull TEE-signed reasoning from the 0G broker.
    const reasoning: SealedReasoning = await fetchSealedReasoning({
        brokerUrl: cfg.zgBrokerUrl,
        chatId: cfg.zgChatId,
        model: cfg.zgModel,
        signerAddress: cfg.zgSignerAddress
    });

    // 3. Build the intent hash + commit via Pulse.
    const nonce = `0x${"a".repeat(64)}` as Hex; // replace with crypto.randomBytes(32) in prod
    const intentHash = intentHashForSwap(nonce, cfg.poolKey, params);

    const executeAfter = BigInt(Math.floor(Date.now() / 1000) + 60 * 30);
    const revealWindow = 60n * 60n; // 1 hour

    const commitTx = await commitIntent(wallet, cfg.pulseAddress, {
        agentId: cfg.agentId,
        actionData: "0x",
        nonce,
        reasoning,
        reasoningCID: `0x${"0".repeat(64)}` as Hex,
        executeAfter,
        revealWindow
    });
    console.log("commit tx:", commitTx, "intentHash:", intentHash);

    // 4. Later, when the window opens, build the v4 swap with hookData.
    //    The actual swap submission via Universal Router or PoolSwapTest is
    //    out of scope here — this scenario emits the data pieces needed.
    //    See https://docs.uniswap.org/contracts/v4/quickstart/swap for the
    //    Universal Router pattern.
    const commitmentId = await readCommitmentIdFromReceipt(wallet, commitTx);
    const hookData = encodeHookData(commitmentId, nonce);

    return {commitmentId, hookData, intentHash};
}

async function readCommitmentIdFromReceipt(_wallet: unknown, _tx: Hex): Promise<bigint> {
    // Decode the Committed event; left as exercise to wire via viem.getTransactionReceipt
    // + decodeEventLog against PULSE_ABI.
    return 1n;
}
