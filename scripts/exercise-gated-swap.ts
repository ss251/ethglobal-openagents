/**
 * End-to-end exerciser for the PulseGatedHook on Base Sepolia.
 *
 * Demonstrates two paths through the same v4 pool:
 *   A.  Naked swap with no hookData            → hook reverts (MalformedHookData)
 *   B.  Pulse-bound swap with valid commitment → hook calls Pulse.reveal,
 *                                                 swap clears, status→Revealed
 *
 * Reads addresses from .env (populated by Phase1+Phase2 deploys).
 *
 * Run: bun run scripts/exercise-gated-swap.ts
 */

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
    type Address,
    type Hex
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {randomBytes} from "node:crypto";

const RPC = process.env.BASE_SEPOLIA_RPC_URL!;
const PULSE = process.env.PULSE_ADDRESS! as Address;
const HOOK = process.env.HOOK_ADDRESS! as Address;
const SWAP_ROUTER = process.env.POOL_SWAP_TEST! as Address;
const TOKEN0 = process.env.POOL_TOKEN0! as Address;
const TOKEN1 = process.env.POOL_TOKEN1! as Address;
const FEE = Number(process.env.POOL_FEE!);
const TICK_SPACING = Number(process.env.POOL_TICK_SPACING!);

const AGENT_KEY = process.env.AGENT_PRIVATE_KEY! as Hex;
const TEE_KEY = process.env.DEMO_TEE_SIGNER_KEY! as Hex;
const AGENT_ID = BigInt(process.env.AGENT_ID!);

const agent = privateKeyToAccount(AGENT_KEY);
const tee = privateKeyToAccount(TEE_KEY);

const publicClient = createPublicClient({chain: baseSepolia, transport: http(RPC)});
const walletClient = createWalletClient({account: agent, chain: baseSepolia, transport: http(RPC)});

// ─── Constants ────────────────────────────────────────────────────────────
const MIN_SQRT_PRICE = 4295128740n;  // TickMath.MIN_SQRT_PRICE + 1
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341n;  // -1
const SWAP_AMOUNT_IN = parseEther("0.01");

// ─── ABIs ─────────────────────────────────────────────────────────────────
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

// ─── Helpers ──────────────────────────────────────────────────────────────
const STATUS_LABELS = ["Pending", "Revealed", "Violated", "Expired"] as const;

const poolKey = {
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: HOOK
} as const;

const swapParams = {
    zeroForOne: true,
    amountSpecified: -SWAP_AMOUNT_IN,
    sqrtPriceLimitX96: MIN_SQRT_PRICE
} as const;

const testSettings = {takeClaims: false, settleUsingBurn: false} as const;

/// abi.encode(PoolKey, SwapParams) — must byte-match what the hook passes
/// to Pulse.reveal as `actionData`.
function encodeActionData(): Hex {
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

function computeIntentHash(nonce: Hex, actionData: Hex): Hex {
    return keccak256(encodePacked(["bytes32", "bytes"], [nonce, actionData]));
}

async function buildCommitmentSig(args: {
    agentId: bigint;
    intentHash: Hex;
    reasoningCID: Hex;
    executeAfter: bigint;
}): Promise<Hex> {
    // Pulse payload: keccak256(abi.encode(agentId, intentHash, reasoningCID, executeAfter))
    // signed via EIP-191 personal_sign and verified through SignatureChecker.
    const payload = keccak256(
        encodeAbiParameters(
            [{type: "uint256"}, {type: "bytes32"}, {type: "bytes32"}, {type: "uint64"}],
            [args.agentId, args.intentHash, args.reasoningCID, args.executeAfter]
        )
    );
    return tee.signMessage({message: {raw: payload}});
}

async function readStatus(id: bigint, expectNonPending = false): Promise<number> {
    for (let attempt = 0; attempt < 6; attempt++) {
        const status = Number(
            await publicClient.readContract({address: PULSE, abi: PULSE_ABI, functionName: "getStatus", args: [id]})
        );
        if (!expectNonPending || status !== 0) return status;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return 0;
}

// ─── Setup: AGENT mints + approves tokens ─────────────────────────────────
async function ensureFundedAndApproved() {
    const balance = await publicClient.readContract({
        address: TOKEN0,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [agent.address]
    });
    if (balance < parseEther("1")) {
        console.log("  → minting 100 token0 + 100 token1 to AGENT");
        const tx0 = await walletClient.writeContract({
            address: TOKEN0,
            abi: ERC20_ABI,
            functionName: "mint",
            args: [agent.address, parseEther("100")]
        });
        const tx1 = await walletClient.writeContract({
            address: TOKEN1,
            abi: ERC20_ABI,
            functionName: "mint",
            args: [agent.address, parseEther("100")]
        });
        await Promise.all([
            publicClient.waitForTransactionReceipt({hash: tx0}),
            publicClient.waitForTransactionReceipt({hash: tx1})
        ]);
    }
    const allowance = await publicClient.readContract({
        address: TOKEN0,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [agent.address, SWAP_ROUTER]
    });
    if (allowance < parseEther("100")) {
        console.log("  → approving SwapTest router for token0+token1");
        const ax0 = await walletClient.writeContract({
            address: TOKEN0,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [SWAP_ROUTER, 2n ** 256n - 1n]
        });
        const ax1 = await walletClient.writeContract({
            address: TOKEN1,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [SWAP_ROUTER, 2n ** 256n - 1n]
        });
        await Promise.all([
            publicClient.waitForTransactionReceipt({hash: ax0}),
            publicClient.waitForTransactionReceipt({hash: ax1})
        ]);
    }
}

// ─── Path A: naked swap, no hookData → hook reverts ───────────────────────
async function tryNakedSwap() {
    console.log("\n──────────────────────────────────────────────────────────────────");
    console.log(" PATH A — naked swap (no commitment) → expected hook revert");
    console.log("──────────────────────────────────────────────────────────────────");
    const data = encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "swap",
        args: [poolKey, swapParams, testSettings, "0x"]
    });
    try {
        await publicClient.estimateGas({account: agent, to: SWAP_ROUTER, data});
        console.log("  ❌ swap unexpectedly simulated successfully — gating broken");
        return false;
    } catch (err: any) {
        const msg = (err.shortMessage || err.message || String(err)).split("\n")[0];
        console.log(`  ✓ rejected at simulation: ${msg.slice(0, 110)}`);
        return true;
    }
}

// ─── Path B: pre-commit + swap with valid hookData → succeeds ─────────────
async function pulseBoundSwap() {
    console.log("\n──────────────────────────────────────────────────────────────────");
    console.log(" PATH B — Pulse-bound swap (commit, then swap) → expected success");
    console.log("──────────────────────────────────────────────────────────────────");

    const actionData = encodeActionData();
    const nonce = `0x${Buffer.from(randomBytes(32)).toString("hex")}` as Hex;
    const intentHash = computeIntentHash(nonce, actionData);
    const reasoningCID = `0x${Buffer.from(randomBytes(32)).toString("hex")}` as Hex;

    // pad executeAfter slightly so commit settles before reveal — swap router
    // can call Pulse.reveal atomically once we cross the executeAfter boundary
    const block = await publicClient.getBlock({blockTag: "latest"});
    const executeAfter = block.timestamp + 5n;
    const revealWindow = 600n;

    const sealedSig = await buildCommitmentSig({
        agentId: AGENT_ID,
        intentHash,
        reasoningCID,
        executeAfter
    });

    console.log(`  intentHash:   ${intentHash}`);
    console.log(`  nonce:        ${nonce}`);
    console.log(`  executeAfter: ${executeAfter}`);

    const commitData = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "commit",
        args: [AGENT_ID, intentHash, reasoningCID, executeAfter, revealWindow, tee.address, sealedSig]
    });
    const commitTx = await walletClient.sendTransaction({to: PULSE, data: commitData});
    const commitReceipt = await publicClient.waitForTransactionReceipt({hash: commitTx});
    console.log(`  → commit tx:  ${commitTx}`);

    let commitmentId: bigint | null = null;
    for (const log of commitReceipt.logs) {
        if (log.address.toLowerCase() !== PULSE.toLowerCase()) continue;
        // Committed event: id is topic[1]
        if (log.topics[0]) commitmentId = BigInt(log.topics[1]!);
        if (commitmentId) break;
    }
    if (!commitmentId) throw new Error("commit didn't emit Committed");
    console.log(`  → commitmentId: ${commitmentId}`);

    // Wait for executeAfter to pass on chain time
    while (true) {
        const b = await publicClient.getBlock({blockTag: "latest"});
        if (b.timestamp > executeAfter) break;
        await new Promise((r) => setTimeout(r, 2_000));
    }
    console.log("  → window open, performing gated swap");

    const hookData = encodeAbiParameters(
        [{type: "uint256"}, {type: "bytes32"}],
        [commitmentId, nonce]
    );

    const swapData = encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "swap",
        args: [poolKey, swapParams, testSettings, hookData]
    });
    // Bump gas because hook → Pulse.reveal → ReputationRegistry.giveFeedback
    // estimation underbudgets the inner storage writes (try/catch hides OOG).
    const swapTx = await walletClient.sendTransaction({to: SWAP_ROUTER, data: swapData, gas: 1_200_000n});
    console.log(`  → swap tx:    ${swapTx}`);

    const swapReceipt = await publicClient.waitForTransactionReceipt({hash: swapTx});
    if (swapReceipt.status !== "success") {
        console.log("  ❌ swap reverted on chain");
        return false;
    }

    const finalStatus = await readStatus(commitmentId, true);
    console.log(`  → status: ${STATUS_LABELS[finalStatus]} (cid=${commitmentId})`);
    if (finalStatus !== 1) {
        console.log("  ❌ commitment didn't transition to Revealed");
        return false;
    }
    console.log("  ✓ swap cleared the gate, commitment auto-revealed");
    return true;
}

async function main() {
    console.log("══════════════════════════════════════════════════════════════════");
    console.log(" PulseGatedHook exerciser — Base Sepolia");
    console.log("══════════════════════════════════════════════════════════════════");
    console.log(`  Pulse:      ${PULSE}`);
    console.log(`  Hook:       ${HOOK}`);
    console.log(`  SwapRouter: ${SWAP_ROUTER}`);
    console.log(`  Pool:       ${TOKEN0} ↔ ${TOKEN1}`);
    console.log(`  Agent:      ${agent.address} (id=${AGENT_ID})`);

    await ensureFundedAndApproved();

    const aOk = await tryNakedSwap();
    const bOk = await pulseBoundSwap();

    console.log("\n══════════════════════════════════════════════════════════════════");
    console.log(" SUMMARY");
    console.log("══════════════════════════════════════════════════════════════════");
    console.log(`  Path A (gating works):  ${aOk ? "✓" : "✗"}`);
    console.log(`  Path B (bound swap):    ${bOk ? "✓" : "✗"}`);
    if (!aOk || !bOk) process.exit(1);
}

main().catch((err) => {
    console.error("\n[FATAL]", err);
    process.exit(1);
});
