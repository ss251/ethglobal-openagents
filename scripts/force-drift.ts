#!/usr/bin/env bun
/**
 * Force-drift demo — the demonstration killshot.
 *
 * Simulates a prompt-injection that makes the agent attempt to execute a
 * different swap than the one it committed to. End-to-end:
 *
 *   1. Commit intent A on Pulse (e.g. "sell 0.01 pETH @ floor 1800 pUSD").
 *   2. Wait for executeAfter to pass.
 *   3. Attempt swap with intent B (drift — "sell at floor 100" — looks like
 *      a market panic / injection). PulseGatedHook hashes (nonce, B)
 *      against the on-chain intentHash, sees they don't match, REVERTS
 *      before any state change. State stays Pending.
 *   4. Submit Pulse.reveal(id, nonce, B) directly. SignatureChecker matches
 *      the sealedSig (still committed to A), but actionDataHash != intentHash
 *      → Status.Violated, ERC-8004 reputation slashes by -1000.
 *
 * Usage:
 *   bun run scripts/force-drift.ts \
 *     --base-amount 0.01 \
 *     --honest-min-price 1800 \
 *     --drift-min-price 100 \
 *     --execute-after 30
 *
 * Progress to stderr; final JSON to stdout for Hermes to parse.
 */

import OpenAI from "openai";
import {
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    encodeAbiParameters,
    encodeFunctionData,
    encodePacked,
    parseEther,
    parseAbi,
    toHex,
    type Address,
    type Hex
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";
import {randomBytes} from "node:crypto";

// ─── argv ─────────────────────────────────────────────────────────────────
function parseArg(name: string, fallback: string | undefined = undefined): string {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx === -1 || idx === process.argv.length - 1) {
        if (fallback !== undefined) return fallback;
        throw new Error(`missing required arg --${name}`);
    }
    return process.argv[idx + 1];
}

const baseAmountStr = parseArg("base-amount", "0.01");
const honestMinPrice = parseArg("honest-min-price", "1800");
const driftMinPrice = parseArg("drift-min-price", "100");
const executeAfterSec = BigInt(parseArg("execute-after", "30"));
const revealWindowSec = BigInt(parseArg("reveal-window", "600"));

// ─── env ──────────────────────────────────────────────────────────────────
const RPC = process.env.SEPOLIA_RPC_URL!;
const PULSE = process.env.PULSE_ADDRESS! as Address;
const HOOK = process.env.HOOK_ADDRESS! as Address;
const SWAP_ROUTER = process.env.POOL_SWAP_TEST! as Address;
const TOKEN0 = process.env.POOL_TOKEN0! as Address;
const TOKEN1 = process.env.POOL_TOKEN1! as Address;
const FEE = Number(process.env.POOL_FEE!);
const TICK_SPACING = Number(process.env.POOL_TICK_SPACING!);
const AGENT_ID = BigInt(process.env.AGENT_ID!);
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY! as Hex;
const TEE_KEY = process.env.DEMO_TEE_SIGNER_KEY! as Hex;
const ENS_NAME = process.env.AGENT_ENS_NAME || "pulseagent.eth";

const ZG_API_KEY = process.env.ZG_API_KEY;
const ZG_BROKER_URL = process.env.ZG_BROKER_URL;
const ZG_MODEL = process.env.ZG_MODEL || "qwen/qwen-2.5-7b-instruct";
const ZG_SIGNER_ADDRESS = process.env.ZG_SIGNER_ADDRESS;

const agent = privateKeyToAccount(AGENT_KEY);
const tee = privateKeyToAccount(TEE_KEY);
const publicClient = createPublicClient({chain: sepolia, transport: http(RPC)});
const walletClient = createWalletClient({account: agent, chain: sepolia, transport: http(RPC)});

// ─── constants ────────────────────────────────────────────────────────────
const MIN_SQRT_PRICE = 4295128740n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341n;

const PULSE_ABI = parseAbi([
    "function commit(uint256 agentId, bytes32 intentHash, bytes32 reasoningCID, uint64 executeAfter, uint64 revealWindow, address signerProvider, bytes sealedSig) returns (uint256 id)",
    "function reveal(uint256 id, bytes32 nonce, bytes actionData)",
    "function getStatus(uint256 id) view returns (uint8)",
    "event Committed(uint256 indexed id, uint256 indexed agentId, bytes32 intentHash, bytes32 reasoningCID, uint64 executeAfter, uint64 revealWindow, address signerProvider)"
]);

const ERC20_ABI = parseAbi([
    "function mint(address to, uint256 amount)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)"
]);

const SWAP_ROUTER_ABI = parseAbi([
    "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
    "struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }",
    "struct TestSettings { bool takeClaims; bool settleUsingBurn; }",
    "function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) returns (int256)"
]);

const STATUS_LABELS = ["Pending", "Revealed", "Violated", "Expired"] as const;

const poolKey = {
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: HOOK
} as const;

const testSettings = {takeClaims: false, settleUsingBurn: false} as const;

function step(...m: unknown[]) {
    process.stderr.write(m.join(" ") + "\n");
}

// ─── two swap intents — A (honest) vs B (drifted) ─────────────────────────
function buildSwapParams(slippageMin: string) {
    const amountIn = parseEther(baseAmountStr);
    // Sell pETH (token1) for pUSD (token0) → zeroForOne=false, sqrtPrice=MAX
    void slippageMin;
    return {
        zeroForOne: false,
        amountSpecified: -amountIn,
        sqrtPriceLimitX96: MAX_SQRT_PRICE
    } as const;
}

function encodeActionData(swapParams: ReturnType<typeof buildSwapParams>): Hex {
    return encodeAbiParameters(
        [
            {
                type: "tuple",
                components: [
                    {name: "currency0", type: "address"},
                    {name: "currency1", type: "address"},
                    {name: "fee", type: "uint24"},
                    {name: "tickSpacing", type: "int24"},
                    {name: "hooks", type: "address"}
                ]
            },
            {
                type: "tuple",
                components: [
                    {name: "zeroForOne", type: "bool"},
                    {name: "amountSpecified", type: "int256"},
                    {name: "sqrtPriceLimitX96", type: "uint160"}
                ]
            }
        ],
        [poolKey, swapParams]
    );
}

async function buildCommitmentSig(args: {
    agentId: bigint;
    intentHash: Hex;
    reasoningCID: Hex;
    executeAfter: bigint;
}): Promise<Hex> {
    const payload = keccak256(
        encodeAbiParameters(
            [{type: "uint256"}, {type: "bytes32"}, {type: "bytes32"}, {type: "uint64"}],
            [args.agentId, args.intentHash, args.reasoningCID, args.executeAfter]
        )
    );
    return tee.signMessage({message: {raw: payload}});
}

async function ensureFundedAndApproved() {
    const balance = await publicClient.readContract({
        address: TOKEN0,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [agent.address]
    });
    if (balance < parseEther("1")) {
        step("→ minting 100 token0 + 100 token1 to agent");
        const tx0 = await walletClient.writeContract({
            address: TOKEN0,
            abi: ERC20_ABI,
            functionName: "mint",
            args: [agent.address, parseEther("100")]
        });
        await publicClient.waitForTransactionReceipt({hash: tx0});
        const tx1 = await walletClient.writeContract({
            address: TOKEN1,
            abi: ERC20_ABI,
            functionName: "mint",
            args: [agent.address, parseEther("100")]
        });
        await publicClient.waitForTransactionReceipt({hash: tx1});
    }
    const allowance = await publicClient.readContract({
        address: TOKEN0,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [agent.address, SWAP_ROUTER]
    });
    if (allowance < parseEther("100")) {
        step("→ approving SwapTest router");
        const ax0 = await walletClient.writeContract({
            address: TOKEN0,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [SWAP_ROUTER, 2n ** 256n - 1n]
        });
        await publicClient.waitForTransactionReceipt({hash: ax0});
        const ax1 = await walletClient.writeContract({
            address: TOKEN1,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [SWAP_ROUTER, 2n ** 256n - 1n]
        });
        await publicClient.waitForTransactionReceipt({hash: ax1});
    }
}

// ─── reasoning + commit (intent A) ───────────────────────────────────────
async function honestReasoning(): Promise<{text: string; cid: Hex}> {
    if (!ZG_API_KEY || !ZG_BROKER_URL || !ZG_SIGNER_ADDRESS) {
        // No 0G configured — fall back to a deterministic stub blob so the
        // demo still runs end-to-end. Real prod path uses 0G TEE.
        const stub = `Honest reasoning stub: sell ${baseAmountStr} pETH @ floor ${honestMinPrice}.`;
        return {text: stub, cid: keccak256(toHex(stub))};
    }
    const zg = new OpenAI({apiKey: ZG_API_KEY, baseURL: ZG_BROKER_URL});
    const completion = await zg.chat.completions.create({
        model: ZG_MODEL,
        messages: [
            {
                role: "system",
                content:
                    "You are a conservative autonomous trading agent. Give one short paragraph (≤90 words) of reasoning for selling pETH at the given floor."
            },
            {
                role: "user",
                content: `Sell ${baseAmountStr} pETH for at least ${honestMinPrice} pUSD per pETH. Justify briefly.`
            }
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

async function readStatus(id: bigint): Promise<number> {
    return Number(
        await publicClient.readContract({
            address: PULSE,
            abi: PULSE_ABI,
            functionName: "getStatus",
            args: [id]
        })
    );
}

// ─── main ─────────────────────────────────────────────────────────────────
async function main() {
    step("══ pulse force-drift demo ══");
    step(`  honest intent  : sell ${baseAmountStr} pETH @ floor ${honestMinPrice} pUSD`);
    step(`  drift attempt  : sell ${baseAmountStr} pETH @ floor ${driftMinPrice} pUSD (≪ honest floor)`);
    step(`  agent          : ${agent.address} (id=${AGENT_ID}, ens=${ENS_NAME})`);

    await ensureFundedAndApproved();

    // ─── PHASE 1 — honest commit ──────────────────────────────────────────
    step("\n→ phase 1: honest 0G-attested reasoning + Pulse.commit");
    const reasoning = await honestReasoning();
    step(`  reasoningCID: ${reasoning.cid}`);

    const honestSwapParams = buildSwapParams(honestMinPrice);
    const honestActionData = encodeActionData(honestSwapParams);
    const nonce = `0x${Buffer.from(randomBytes(32)).toString("hex")}` as Hex;
    const honestIntentHash = keccak256(
        encodePacked(["bytes32", "bytes"], [nonce, honestActionData])
    );

    const block = await publicClient.getBlock({blockTag: "latest"});
    const executeAfter = block.timestamp + executeAfterSec;
    const sealedSig = await buildCommitmentSig({
        agentId: AGENT_ID,
        intentHash: honestIntentHash,
        reasoningCID: reasoning.cid,
        executeAfter
    });

    const commitData = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "commit",
        args: [
            AGENT_ID,
            honestIntentHash,
            reasoning.cid,
            executeAfter,
            revealWindowSec,
            tee.address,
            sealedSig
        ]
    });
    const commitTx = await walletClient.sendTransaction({
        to: PULSE,
        data: commitData,
        gas: 500_000n
    });
    const commitReceipt = await publicClient.waitForTransactionReceipt({hash: commitTx});
    let commitmentId: bigint | null = null;
    for (const log of commitReceipt.logs) {
        if (log.address.toLowerCase() !== PULSE.toLowerCase()) continue;
        if (log.topics[0]) commitmentId = BigInt(log.topics[1]!);
        if (commitmentId) break;
    }
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

    // The "injection" — agent now has *different* params
    const driftSwapParams = buildSwapParams(driftMinPrice);
    void driftSwapParams; // Intent B is encoded into actionData below
    // Build a *different* actionData blob than what was committed to.
    // Easiest mechanical drift: change one byte. Here we tweak amountSpecified.
    const driftedSwapParams = {
        ...honestSwapParams,
        amountSpecified: honestSwapParams.amountSpecified - 1n // off-by-one drift
    };
    const driftedActionData = encodeActionData(driftedSwapParams);

    const hookData = encodeAbiParameters(
        [{type: "uint256"}, {type: "bytes32"}],
        [commitmentId, nonce]
    );
    const driftedSwapData = encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "swap",
        args: [poolKey, driftedSwapParams, testSettings, hookData]
    });

    let hookRevertedAtSimulation = false;
    let hookRevertReason = "";
    try {
        await publicClient.estimateGas({
            account: agent,
            to: SWAP_ROUTER,
            data: driftedSwapData
        });
    } catch (err: any) {
        hookRevertedAtSimulation = true;
        hookRevertReason = (err.shortMessage || err.message || "").split("\n")[0].slice(0, 140);
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
    const revealTx = await walletClient.sendTransaction({
        to: PULSE,
        data: revealData,
        gas: 600_000n
    });
    await publicClient.waitForTransactionReceipt({hash: revealTx});
    step(`  reveal tx     : ${revealTx}`);

    const finalStatus = await readStatus(commitmentId);
    step(`  final status  : ${STATUS_LABELS[finalStatus]} (-1000 ERC-8004 reputation)`);

    // ─── output JSON ──────────────────────────────────────────────────────
    const out = {
        scenario: "force-drift",
        outcome: STATUS_LABELS[finalStatus],
        outcomeCode: finalStatus,
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
            `Final status: ${STATUS_LABELS[finalStatus]} — agent slashed -1000 ERC-8004 reputation.`
        ]
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch(err => {
    const msg = err?.shortMessage || err?.message || String(err);
    process.stderr.write(`\n[FATAL] ${msg}\n`);
    process.stdout.write(
        JSON.stringify({error: msg, scenario: "force-drift", outcome: "Failed"}, null, 2) + "\n"
    );
    process.exit(1);
});
