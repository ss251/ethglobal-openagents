#!/usr/bin/env bun
/**
 * Autonomous Pulse-bound trade — the script side of the
 * `pulse-autonomous-trade` skill.
 *
 * One subprocess does the entire commit → wait → atomic-reveal swap
 * cycle. Progress is printed to stderr (so the agent can narrate it
 * while the script runs); a single JSON object is printed to stdout
 * at the end (so the agent can structure the final reply).
 *
 * Usage:
 *   bun run scripts/autonomous-trade.ts \
 *     --direction sell \
 *     --base-amount 0.01 \
 *     --min-price 1800 \
 *     --execute-after 30 \
 *     --reveal-window 600
 *
 * Required env:
 *   SEPOLIA_RPC_URL, PULSE_ADDRESS, HOOK_ADDRESS,
 *   POOL_TOKEN0, POOL_TOKEN1, POOL_FEE, POOL_TICK_SPACING, POOL_SWAP_TEST,
 *   AGENT_ID, AGENT_PRIVATE_KEY, DEMO_TEE_SIGNER_KEY,
 *   ZG_API_KEY, ZG_BROKER_URL, ZG_MODEL, ZG_SIGNER_ADDRESS,
 *   AGENT_ENS_NAME (informational)
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

// ─── argv parsing ─────────────────────────────────────────────────────────
function parseArg(name: string, fallback: string | undefined = undefined): string {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx === -1 || idx === process.argv.length - 1) {
        if (fallback !== undefined) return fallback;
        throw new Error(`missing required arg --${name}`);
    }
    return process.argv[idx + 1];
}

const direction = parseArg("direction"); // "sell" | "buy"
const baseAmountStr = parseArg("base-amount");
const minPriceStr = parseArg("min-price", "0");
const executeAfterSec = BigInt(parseArg("execute-after", "30"));
const revealWindowSec = BigInt(parseArg("reveal-window", "600"));

if (direction !== "sell" && direction !== "buy") {
    throw new Error(`--direction must be 'sell' or 'buy', got ${direction}`);
}

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

const ZG_API_KEY = process.env.ZG_API_KEY!;
const ZG_BROKER_URL = process.env.ZG_BROKER_URL!;
const ZG_MODEL = process.env.ZG_MODEL || "qwen/qwen-2.5-7b-instruct";
const ZG_SIGNER_ADDRESS = process.env.ZG_SIGNER_ADDRESS!;

const agent = privateKeyToAccount(AGENT_KEY);
const tee = privateKeyToAccount(TEE_KEY);
const zg = new OpenAI({apiKey: ZG_API_KEY, baseURL: ZG_BROKER_URL});

const publicClient = createPublicClient({chain: sepolia, transport: http(RPC)});
const walletClient = createWalletClient({account: agent, chain: sepolia, transport: http(RPC)});

// ─── constants ────────────────────────────────────────────────────────────
const MIN_SQRT_PRICE = 4295128740n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341n;

const PULSE_ABI = parseAbi([
    "function commit(uint256 agentId, bytes32 intentHash, bytes32 reasoningCID, uint64 executeAfter, uint64 revealWindow, address signerProvider, bytes sealedSig) returns (uint256 id)",
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

// ─── progress logging — all to stderr so stdout is clean JSON ─────────────
function step(...m: unknown[]) {
    process.stderr.write(m.join(" ") + "\n");
}

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
    const cid = keccak256(toHex(blob));
    return {text, cid};
}

// ─── pool key + swap params (zeroForOne sell pETH → pUSD) ─────────────────
const poolKey = {
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: HOOK
} as const;

function buildSwapParams(intent: Intent) {
    const amountIn = parseEther(intent.baseAmount);
    // For sell pETH → pUSD: zeroForOne depends on which token is currency0.
    // In our pool, TOKEN0 = pUSD, TOKEN1 = pWETH. So zeroForOne=false sells token1 (pETH) for token0 (pUSD).
    // For buy pETH (=spend pUSD): zeroForOne=true.
    const zeroForOne = intent.direction === "buy";
    const sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
    return {
        zeroForOne,
        amountSpecified: -amountIn, // exact-in
        sqrtPriceLimitX96
    } as const;
}

const testSettings = {takeClaims: false, settleUsingBurn: false} as const;

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

// ─── token funding ────────────────────────────────────────────────────────
async function ensureFundedAndApproved(swapAmount: bigint) {
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
    const allowance0 = await publicClient.readContract({
        address: TOKEN0,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [agent.address, SWAP_ROUTER]
    });
    if (allowance0 < swapAmount) {
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

// ─── commitment signing ───────────────────────────────────────────────────
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

// ─── main flow ────────────────────────────────────────────────────────────
async function main() {
    const intent: Intent = {
        direction: direction as "sell" | "buy",
        baseAmount: baseAmountStr,
        minPrice: minPriceStr
    };

    step("══ pulse-autonomous-trade ══");
    step(`  intent: ${intent.direction} ${intent.baseAmount} pETH @ min ${intent.minPrice} pUSD`);
    step(`  agent : ${agent.address} (id=${AGENT_ID}, ens=${ENS_NAME})`);

    const swapParams = buildSwapParams(intent);
    const swapAmount = -swapParams.amountSpecified as bigint;
    await ensureFundedAndApproved(swapAmount);

    // 1. Sealed reasoning via 0G TEE
    step("\n→ 0G sealed reasoning (qwen-2.5-7b TEE)…");
    const reasoning = await sealedReasoning(intent);
    step(`  reasoningCID: ${reasoning.cid}`);
    step(`  decision   : ${reasoning.text.slice(-80)}`);

    // 2. Compute intent hash
    const actionData = encodeActionData(swapParams);
    const nonce = `0x${Buffer.from(randomBytes(32)).toString("hex")}` as Hex;
    const intentHash = keccak256(encodePacked(["bytes32", "bytes"], [nonce, actionData]));
    step(`\n→ intent hash: ${intentHash}`);
    step(`  nonce      : ${nonce}`);

    // 3. Submit Pulse.commit
    const block = await publicClient.getBlock({blockTag: "latest"});
    const executeAfter = block.timestamp + executeAfterSec;
    const sealedSig = await buildCommitmentSig({
        agentId: AGENT_ID,
        intentHash,
        reasoningCID: reasoning.cid,
        executeAfter
    });
    step(`\n→ Pulse.commit (executeAfter=${executeAfter}, revealWindow=${revealWindowSec}s)…`);
    const commitData = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "commit",
        args: [
            AGENT_ID,
            intentHash,
            reasoning.cid,
            executeAfter,
            revealWindowSec,
            tee.address,
            sealedSig
        ]
    });
    // Same OOG-success-branch underbudgeting that hits reveal — be explicit.
    const commitTx = await walletClient.sendTransaction({to: PULSE, data: commitData, gas: 500_000n});
    const commitReceipt = await publicClient.waitForTransactionReceipt({hash: commitTx});
    let commitmentId: bigint | null = null;
    for (const log of commitReceipt.logs) {
        if (log.address.toLowerCase() !== PULSE.toLowerCase()) continue;
        if (log.topics[0]) commitmentId = BigInt(log.topics[1]!);
        if (commitmentId) break;
    }
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
    const hookData = encodeAbiParameters(
        [{type: "uint256"}, {type: "bytes32"}],
        [commitmentId, nonce]
    );
    const swapData = encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "swap",
        args: [poolKey, swapParams, testSettings, hookData]
    });
    const swapTx = await walletClient.sendTransaction({
        to: SWAP_ROUTER,
        data: swapData,
        gas: 1_200_000n // hook → reveal → giveFeedback underbudgeted by RPCs
    });
    const swapReceipt = await publicClient.waitForTransactionReceipt({hash: swapTx});
    if (swapReceipt.status !== "success") throw new Error("swap reverted on chain");
    step(`  swap tx: ${swapTx}`);

    // 6. Read final status
    const finalStatus = await readStatus(commitmentId);
    const revealedBlock = await publicClient.getBlock({blockTag: "latest"});
    step(`\n→ final status: ${STATUS_LABELS[finalStatus]} (cid=${commitmentId})`);

    // 7. Emit single JSON object on stdout for Hermes to parse
    const out = {
        status: STATUS_LABELS[finalStatus],
        statusCode: finalStatus,
        commitmentId: commitmentId.toString(),
        commitTx,
        swapTx,
        intentHash,
        reasoningCID: reasoning.cid,
        nonce,
        executeAfter: Number(executeAfter),
        revealWindow: Number(revealWindowSec),
        revealedAtSec: Number(revealedBlock.timestamp),
        agentId: AGENT_ID.toString(),
        ensName: ENS_NAME,
        signerProvider: tee.address,
        reasoningSummary: reasoning.text.slice(0, 400),
        explorer: {
            commit: `https://sepolia.etherscan.io/tx/${commitTx}`,
            swap: `https://sepolia.etherscan.io/tx/${swapTx}`,
            ens: `https://sepolia.app.ens.domains/${ENS_NAME}`,
            pulse: `https://sepolia.etherscan.io/address/${PULSE}#events`
        }
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch(err => {
    const msg = err?.shortMessage || err?.message || String(err);
    process.stderr.write(`\n[FATAL] ${msg}\n`);
    process.stdout.write(
        JSON.stringify({error: msg, status: "Failed"}, null, 2) + "\n"
    );
    process.exit(1);
});
