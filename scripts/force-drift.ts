#!/usr/bin/env bun
/**
 * Force-drift demo — the demonstration killshot.
 *
 * Simulates a prompt-injection that makes the agent attempt to execute a
 * different swap than the one it committed to. End-to-end:
 *
 *   1. Commit intent A on Pulse (e.g. "sell 0.005 pETH @ floor 1800 pUSD").
 *   2. Wait for executeAfter to pass.
 *   3. Attempt swap with intent B (drift — off-by-one amountSpecified).
 *      PulseGatedHook hashes (nonce, B) against the on-chain intentHash, sees
 *      they don't match, REVERTS before any state change. State stays Pending.
 *   4. Submit Pulse.reveal(id, nonce, B) directly. SignatureChecker matches
 *      the sealedSig (still committed to A), but actionDataHash != intentHash
 *      → Status.Violated, ERC-8004 reputation slashes by -1000.
 *
 * Usage:
 *   bun run scripts/force-drift.ts \
 *     --base-amount 0.005 \
 *     --honest-min-price 1800 \
 *     --drift-min-price 100 \
 *     --execute-after 30
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
import {PULSE_ABI, SWAP_ROUTER_ABI, MAX_SQRT_PRICE, STATUS_LABELS} from "./_lib/abi";
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

const baseAmountStr = parseArg("base-amount", "0.005");
const honestMinPrice = parseArg("honest-min-price", "1800");
const driftMinPrice = parseArg("drift-min-price", "100");
const executeAfterSec = BigInt(parseArg("execute-after", "30"));
const revealWindowSec = BigInt(parseArg("reveal-window", "600"));

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

const ZG_API_KEY = process.env.ZG_API_KEY;
const ZG_BROKER_URL = process.env.ZG_BROKER_URL;
const ZG_MODEL = process.env.ZG_MODEL || "qwen/qwen-2.5-7b-instruct";
const ZG_SIGNER_ADDRESS = process.env.ZG_SIGNER_ADDRESS;

const agent = privateKeyToAccount(AGENT_KEY);
const tee = privateKeyToAccount(TEE_KEY);
const publicClient = createPublicClient({chain: sepolia, transport: http(RPC)});
const walletClient = createWalletClient({account: agent, chain: sepolia, transport: http(RPC)});

const poolKey = {
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: HOOK
} as const;

const testSettings = {takeClaims: false, settleUsingBurn: false} as const;

// ─── two swap intents — A (honest) vs B (drifted) ─────────────────────────
function buildHonestSwapParams() {
    const amountIn = parseEther(baseAmountStr);
    // Sell pETH (token1) for pUSD (token0) → zeroForOne=false, sqrtPrice=MAX.
    return {
        zeroForOne: false,
        amountSpecified: -amountIn,
        sqrtPriceLimitX96: MAX_SQRT_PRICE
    } as const;
}

// ─── reasoning + commit (intent A) ────────────────────────────────────────
async function honestReasoning(): Promise<{text: string; cid: Hex}> {
    if (!ZG_API_KEY || !ZG_BROKER_URL || !ZG_SIGNER_ADDRESS) {
        const stub = `Honest reasoning stub: sell ${baseAmountStr} pETH @ floor ${honestMinPrice}.`;
        return {text: stub, cid: keccak256(toHex(stub))};
    }
    const zg = new OpenAI({apiKey: ZG_API_KEY, baseURL: ZG_BROKER_URL});
    const completion = await zg.chat.completions.create({
        model: ZG_MODEL,
        messages: [
            {role: "system", content: "You are a conservative autonomous trading agent. Give one short paragraph (≤90 words) of reasoning for selling pETH at the given floor."},
            {role: "user", content: `Sell ${baseAmountStr} pETH for at least ${honestMinPrice} pUSD per pETH. Justify briefly.`}
        ],
        max_tokens: 200
    });
    const text = completion.choices[0]?.message?.content ?? "";
    const blob = JSON.stringify({
        model: ZG_MODEL,
        provider: ZG_SIGNER_ADDRESS,
        prompt: `sell ${baseAmountStr} pETH @ ${honestMinPrice}`,
        response: text
    });
    return {text, cid: keccak256(toHex(blob))};
}

// ─── main ─────────────────────────────────────────────────────────────────
async function main() {
    step("══ pulse force-drift demo ══");
    step(`  honest intent  : sell ${baseAmountStr} pETH @ floor ${honestMinPrice} pUSD`);
    step(`  drift attempt  : off-by-one amountSpecified (≪ honest intent)`);
    step(`  agent          : ${agent.address} (id=${AGENT_ID}, ens=${ENS_NAME})`);

    // Direction-aware funding for the *honest* swap (the only one we'd actually try to settle).
    const honestSwapParams = buildHonestSwapParams();
    const swapAmount = -honestSwapParams.amountSpecified as bigint;
    const fund = await ensureFundedAndApproved(
        publicClient,
        walletClient,
        agent,
        {token0: TOKEN0, token1: TOKEN1, swapRouter: SWAP_ROUTER},
        {zeroForOne: honestSwapParams.zeroForOne, amountIn: swapAmount},
        step
    );
    step(`  funding: minted=${fund.minted} approved=${fund.approved} balance=${fund.balanceAfter}`);

    // ─── PHASE 1 — honest commit ──────────────────────────────────────────
    step("\n→ phase 1: honest 0G-attested reasoning + Pulse.commit");
    const reasoning = await honestReasoning();
    step(`  reasoningCID: ${reasoning.cid}`);

    const honestActionData = encodeActionData(poolKey, honestSwapParams);
    const nonce = `0x${Buffer.from(randomBytes(32)).toString("hex")}` as Hex;
    const honestIntentHash = keccak256(encodePacked(["bytes32", "bytes"], [nonce, honestActionData]));

    const block = await publicClient.getBlock({blockTag: "latest"});
    const executeAfter = block.timestamp + executeAfterSec;
    const sealedSig = await signCommitmentPayload(tee, {
        agentId: AGENT_ID,
        intentHash: honestIntentHash,
        reasoningCID: reasoning.cid,
        executeAfter
    });

    const commitData = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "commit",
        args: [AGENT_ID, honestIntentHash, reasoning.cid, executeAfter, revealWindowSec, tee.address, sealedSig]
    });
    const commitTx = await walletClient.sendTransaction({to: PULSE, data: commitData, gas: 500_000n});
    const commitReceipt = await publicClient.waitForTransactionReceipt({hash: commitTx});
    const commitmentId = extractCommitmentId(PULSE, commitReceipt.logs);
    if (!commitmentId) throw new Error("commit didn't emit Committed");
    step(`  commit tx     : ${commitTx}`);
    step(`  commitmentId  : ${commitmentId} (status=Pending)`);

    // ─── PHASE 2 — wait, then attempt drifted swap ────────────────────────
    step("\n→ phase 2: wait executeAfter, then attempt DRIFTED swap (different params)");
    while (true) {
        const b = await publicClient.getBlock({blockTag: "latest"});
        if (b.timestamp > executeAfter) break;
        await new Promise(r => setTimeout(r, 2_000));
    }
    step("  window open");
    void driftMinPrice; // narrative-only flag (off-by-one is the actual drift)

    // The "injection" — agent now has *different* params (off-by-one).
    const driftedSwapParams = {
        ...honestSwapParams,
        amountSpecified: honestSwapParams.amountSpecified - 1n
    };
    const driftedActionData = encodeActionData(poolKey, driftedSwapParams);

    const hookData = encodeHookData(commitmentId, nonce);
    const driftedSwapData = encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "swap",
        args: [poolKey, driftedSwapParams, testSettings, hookData]
    });

    let hookRevertedAtSimulation = false;
    let hookRevertReason = "";
    try {
        await publicClient.estimateGas({account: agent, to: SWAP_ROUTER, data: driftedSwapData});
    } catch (err: unknown) {
        const e = err as {shortMessage?: string; message?: string};
        hookRevertedAtSimulation = true;
        hookRevertReason = (e.shortMessage || e.message || "").split("\n")[0].slice(0, 140);
    }
    if (!hookRevertedAtSimulation) {
        step("  ❌ drifted swap unexpectedly simulated successfully — gating broken");
    } else {
        step(`  ✓ drifted swap rejected by hook: ${hookRevertReason}`);
        step(`    (status still Pending — atomic-rollback gap means no slash yet)`);
    }

    // ─── PHASE 3 — close the rollback gap with direct Pulse.reveal(drifted) ─
    step("\n→ phase 3: watcher closes rollback gap — direct Pulse.reveal with DRIFTED data");
    const revealData = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "reveal",
        args: [commitmentId, nonce, driftedActionData]
    });
    const revealTx = await walletClient.sendTransaction({to: PULSE, data: revealData, gas: 600_000n});
    await publicClient.waitForTransactionReceipt({hash: revealTx});
    step(`  reveal tx     : ${revealTx}`);

    const finalStatus = await readStatus(publicClient, PULSE, commitmentId);
    step(`  final status  : ${finalStatus.label} (-1000 ERC-8004 reputation)`);

    return {
        scenario: "force-drift",
        outcome: finalStatus.label,
        outcomeCode: finalStatus.code,
        commitmentId: commitmentId.toString(),
        agentId: AGENT_ID.toString(),
        ensName: ENS_NAME,
        honest: {
            intentHash: honestIntentHash,
            reasoningCID: reasoning.cid,
            commitTx,
            executeAfter: Number(executeAfter)
        },
        drift: {
            attemptedSwapData: driftedSwapData,
            simulationReverted: hookRevertedAtSimulation,
            revertReason: hookRevertReason || null,
            revealTx
        },
        explorer: {
            commit: `https://sepolia.etherscan.io/tx/${commitTx}`,
            reveal: `https://sepolia.etherscan.io/tx/${revealTx}`,
            pulseEvents: `https://sepolia.etherscan.io/address/${PULSE}#events`,
            ens: `https://sepolia.app.ens.domains/${ENS_NAME}`
        },
        narrative: [
            `Agent committed honest intent (cid=${commitmentId}) on tx ${commitTx}.`,
            hookRevertedAtSimulation
                ? `Drifted swap was rejected by PulseGatedHook before any state change.`
                : `Drifted swap simulated successfully — hook gating may be broken.`,
            `Watcher closed the rollback gap with direct Pulse.reveal(drifted) on tx ${revealTx}.`,
            `Final status: ${finalStatus.label} — agent slashed -1000 ERC-8004 reputation.`
        ]
    };
}

void STATUS_LABELS;
runMain("force-drift", main);
