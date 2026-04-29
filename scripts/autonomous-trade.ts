#!/usr/bin/env bun
/**
 * Autonomous Pulse-bound trade — the script side of the
 * `pulse-autonomous-trade` skill.
 *
 * Subprocess does the entire commit → wait → atomic-reveal swap cycle.
 * Progress to stderr (so the agent narrates while the script runs); single
 * JSON object to stdout at the end (so the agent can structure the reply).
 *
 * Usage:
 *   bun run scripts/autonomous-trade.ts \
 *     --direction sell \
 *     --base-amount 0.005 \
 *     --min-price 1500 \
 *     --execute-after 30 \
 *     --reveal-window 600
 *
 * Required env (auto-loaded from .env via _lib/env):
 *   SEPOLIA_RPC_URL, PULSE_ADDRESS, HOOK_ADDRESS,
 *   POOL_TOKEN0, POOL_TOKEN1, POOL_FEE, POOL_TICK_SPACING, POOL_SWAP_TEST,
 *   AGENT_ID, AGENT_PRIVATE_KEY, DEMO_TEE_SIGNER_KEY,
 *   ZG_API_KEY, ZG_BROKER_URL, ZG_MODEL, ZG_SIGNER_ADDRESS,
 *   AGENT_ENS_NAME (informational)
 */

import OpenAI from "openai";
import {
    type Address,
    type Hex,
    createPublicClient,
    createWalletClient,
    encodeFunctionData,
    encodePacked,
    http,
    keccak256,
    parseEther,
    toHex
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";
import {randomBytes} from "node:crypto";

import {loadEnv, requireEnv} from "./_lib/env";
import {PULSE_ABI, SWAP_ROUTER_ABI, MIN_SQRT_PRICE, MAX_SQRT_PRICE} from "./_lib/abi";
import {ensureFundedAndApproved} from "./_lib/funding";
import {encodeActionData, encodeHookData, extractCommitmentId, readStatus, signCommitmentPayload} from "./_lib/pulse";
import {step, runMain} from "./_lib/output";

loadEnv();

// ─── argv ─────────────────────────────────────────────────────────────────
function parseArg(name: string, fallback?: string): string {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx === -1 || idx === process.argv.length - 1) {
        if (fallback !== undefined) return fallback;
        throw new Error(`missing required arg --${name}`);
    }
    return process.argv[idx + 1];
}

const direction = parseArg("direction");
const baseAmountStr = parseArg("base-amount");
const minPriceStr = parseArg("min-price", "0");
const executeAfterSec = BigInt(parseArg("execute-after", "30"));
const revealWindowSec = BigInt(parseArg("reveal-window", "600"));

if (direction !== "sell" && direction !== "buy") {
    throw new Error(`--direction must be 'sell' or 'buy', got ${direction}`);
}

// ─── env ──────────────────────────────────────────────────────────────────
const RPC = requireEnv("SEPOLIA_RPC_URL");
const PULSE = requireEnv("PULSE_ADDRESS") as Address;
const HOOK = requireEnv("HOOK_ADDRESS") as Address;
const SWAP_ROUTER = requireEnv("POOL_SWAP_TEST") as Address;
const TOKEN0 = requireEnv("POOL_TOKEN0") as Address;
const TOKEN1 = requireEnv("POOL_TOKEN1") as Address;
const FEE = Number(requireEnv("POOL_FEE"));
const TICK_SPACING = Number(requireEnv("POOL_TICK_SPACING"));
const AGENT_ID = BigInt(requireEnv("AGENT_ID"));
const AGENT_KEY = requireEnv("AGENT_PRIVATE_KEY") as Hex;
const TEE_KEY = requireEnv("DEMO_TEE_SIGNER_KEY") as Hex;
const ENS_NAME = process.env.AGENT_ENS_NAME || "pulseagent.eth";

const ZG_API_KEY = requireEnv("ZG_API_KEY");
const ZG_BROKER_URL = requireEnv("ZG_BROKER_URL");
const ZG_MODEL = process.env.ZG_MODEL || "qwen/qwen-2.5-7b-instruct";
const ZG_SIGNER_ADDRESS = requireEnv("ZG_SIGNER_ADDRESS");

const agent = privateKeyToAccount(AGENT_KEY);
const tee = privateKeyToAccount(TEE_KEY);
const zg = new OpenAI({apiKey: ZG_API_KEY, baseURL: ZG_BROKER_URL});

const publicClient = createPublicClient({chain: sepolia, transport: http(RPC)});
const walletClient = createWalletClient({account: agent, chain: sepolia, transport: http(RPC)});

// ─── 0G sealed reasoning ──────────────────────────────────────────────────
interface Intent {
    direction: "sell" | "buy";
    baseAmount: string;
    minPrice: string;
}

function buildPrompt(intent: Intent) {
    return {
        system:
            "You are an autonomous trading agent. Reason about the swap intent below in 1 short paragraph (≤120 words). Be specific about the price floor that protects the agent. End with one line: DECISION: EXECUTE or DECISION: ABORT.",
        user: `Intent:
  Direction:  ${intent.direction}
  Base:       pETH
  Quote:      pUSD
  Amount:     ${intent.baseAmount}
  Min price:  ${intent.minPrice} pUSD/pETH

Market context: stablecoin pair, low slippage tolerance, on-chain settlement via Uniswap v4 with PulseGatedHook.`
    };
}

async function sealedReasoning(intent: Intent): Promise<{text: string; cid: Hex}> {
    const prompt = buildPrompt(intent);
    const completion = await zg.chat.completions.create({
        model: ZG_MODEL,
        messages: [
            {role: "system", content: prompt.system},
            {role: "user", content: prompt.user}
        ],
        max_tokens: 256
    });
    const text = completion.choices[0]?.message?.content ?? "";
    const blob = JSON.stringify({
        model: ZG_MODEL,
        provider: ZG_SIGNER_ADDRESS,
        prompt,
        response: text
    });
    return {text, cid: keccak256(toHex(blob))};
}

// ─── pool key + swap params ───────────────────────────────────────────────
const poolKey = {
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: HOOK
} as const;

function buildSwapParams(intent: Intent) {
    const amountIn = parseEther(intent.baseAmount);
    // TOKEN0 = pUSD, TOKEN1 = pWETH. Sell pETH → zeroForOne=false (sell TOKEN1).
    // Buy pETH (= spend pUSD) → zeroForOne=true.
    const zeroForOne = intent.direction === "buy";
    const sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
    return {
        zeroForOne,
        amountSpecified: -amountIn,
        sqrtPriceLimitX96
    } as const;
}

const testSettings = {takeClaims: false, settleUsingBurn: false} as const;

// ─── main flow ────────────────────────────────────────────────────────────
async function main() {
    const intent: Intent = {direction: direction as "sell" | "buy", baseAmount: baseAmountStr, minPrice: minPriceStr};

    step("══ pulse-autonomous-trade ══");
    step(`  intent : ${intent.direction} ${intent.baseAmount} pETH @ min ${intent.minPrice} pUSD`);
    step(`  agent  : ${agent.address} (id=${AGENT_ID}, ens=${ENS_NAME})`);

    const swapParams = buildSwapParams(intent);
    const swapAmount = -swapParams.amountSpecified as bigint;

    // Direction-aware funding — only mints/approves the token actually being sold.
    const fund = await ensureFundedAndApproved(
        publicClient,
        walletClient,
        agent,
        {token0: TOKEN0, token1: TOKEN1, swapRouter: SWAP_ROUTER},
        {zeroForOne: swapParams.zeroForOne, amountIn: swapAmount},
        step
    );
    step(`  funding: minted=${fund.minted} approved=${fund.approved} balanceAfter=${fund.balanceAfter}`);

    // 1. Sealed reasoning via 0G TEE
    step("\n→ 0G sealed reasoning (qwen-2.5-7b TEE)…");
    const reasoning = await sealedReasoning(intent);
    step(`  reasoningCID: ${reasoning.cid}`);
    step(`  decision   : ${reasoning.text.slice(-80)}`);

    // 2. Compute intent hash
    const actionData = encodeActionData(poolKey, swapParams);
    const nonce = `0x${Buffer.from(randomBytes(32)).toString("hex")}` as Hex;
    const intentHash = keccak256(encodePacked(["bytes32", "bytes"], [nonce, actionData]));
    step(`\n→ intent hash: ${intentHash}`);
    step(`  nonce      : ${nonce}`);

    // 3. Submit Pulse.commit
    const block = await publicClient.getBlock({blockTag: "latest"});
    const executeAfter = block.timestamp + executeAfterSec;
    const sealedSig = await signCommitmentPayload(tee, {
        agentId: AGENT_ID,
        intentHash,
        reasoningCID: reasoning.cid,
        executeAfter
    });
    step(`\n→ Pulse.commit (executeAfter=${executeAfter}, revealWindow=${revealWindowSec}s)…`);
    const commitData = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "commit",
        args: [AGENT_ID, intentHash, reasoning.cid, executeAfter, revealWindowSec, tee.address, sealedSig]
    });
    const commitTx = await walletClient.sendTransaction({to: PULSE, data: commitData, gas: 500_000n});
    const commitReceipt = await publicClient.waitForTransactionReceipt({hash: commitTx});
    const commitmentId = extractCommitmentId(PULSE, commitReceipt.logs);
    if (!commitmentId) throw new Error("commit didn't emit Committed");
    step(`  commit tx    : ${commitTx}`);
    step(`  commitmentId : ${commitmentId}`);

    // 4. Wait for executeAfter on chain time
    step(`\n→ waiting for executeAfter window…`);
    while (true) {
        const b = await publicClient.getBlock({blockTag: "latest"});
        if (b.timestamp > executeAfter) break;
        await new Promise(r => setTimeout(r, 2_000));
    }
    step(`  window open at block.timestamp > ${executeAfter}`);

    // 5. Submit gated swap with hookData
    step(`\n→ swap via PulseGatedHook (atomic reveal in beforeSwap)…`);
    const hookData = encodeHookData(commitmentId, nonce);
    const swapData = encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "swap",
        args: [poolKey, swapParams, testSettings, hookData]
    });
    const swapTx = await walletClient.sendTransaction({to: SWAP_ROUTER, data: swapData, gas: 1_200_000n});
    const swapReceipt = await publicClient.waitForTransactionReceipt({hash: swapTx});
    if (swapReceipt.status !== "success") {
        // Surface cid + nonce so agent can recover via pulse-retry.
        return {
            scenario: "pulse-autonomous-trade",
            status: "SwapReverted",
            statusCode: -1,
            commitmentId: commitmentId.toString(),
            commitTx,
            swapTx,
            intentHash,
            reasoningCID: reasoning.cid,
            nonce,
            actionData,
            executeAfter: Number(executeAfter),
            revealWindow: Number(revealWindowSec),
            agentId: AGENT_ID.toString(),
            ensName: ENS_NAME,
            recovery: {
                hint: "Swap reverted but commitment is on-chain (Pending). Inspect with pulse-introspect or retry with pulse-retry.",
                pulseRetryCmd: `bun run scripts/pulse-retry.ts --commitment-id ${commitmentId} --nonce ${nonce} --action-data ${actionData}`,
                pulseStatusCmd: `bun run scripts/pulse-status.ts ${commitmentId}`
            }
        };
    }
    step(`  swap tx: ${swapTx}`);

    // 6. Read final status
    const finalStatus = await readStatus(publicClient, PULSE, commitmentId);
    const revealedBlock = await publicClient.getBlock({blockTag: "latest"});
    step(`\n→ final status: ${finalStatus.label} (cid=${commitmentId})`);

    // 7. Emit JSON object on stdout for Hermes to parse
    return {
        scenario: "pulse-autonomous-trade",
        status: finalStatus.label,
        statusCode: finalStatus.code,
        commitmentId: commitmentId.toString(),
        commitTx,
        swapTx,
        intentHash,
        reasoningCID: reasoning.cid,
        nonce,
        actionData,
        executeAfter: Number(executeAfter),
        revealWindow: Number(revealWindowSec),
        revealedAtSec: Number(revealedBlock.timestamp),
        agentId: AGENT_ID.toString(),
        ensName: ENS_NAME,
        signerProvider: tee.address,
        reasoningSummary: reasoning.text.slice(0, 400),
        funding: {
            minted: fund.minted,
            approved: fund.approved,
            balanceBefore: fund.balanceBefore.toString(),
            balanceAfter: fund.balanceAfter.toString()
        },
        explorer: {
            commit: `https://sepolia.etherscan.io/tx/${commitTx}`,
            swap: `https://sepolia.etherscan.io/tx/${swapTx}`,
            ens: `https://sepolia.app.ens.domains/${ENS_NAME}`,
            pulse: `https://sepolia.etherscan.io/address/${PULSE}#events`
        }
    };
}

runMain("pulse-autonomous-trade", main);
