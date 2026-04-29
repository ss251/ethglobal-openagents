/**
 * Violation + watcher-rollback demo.
 *
 * Demonstrates the atomic-reveal rollback gap and the off-chain recovery
 * pattern documented in SPEC.md.
 *
 *  1. AGENT commits to intentHash X (binding swap params Y)
 *  2. AGENT submits swap with hookData=(cid, nonce) but mismatched params Y'
 *     - Hook calls Pulse.reveal — Pulse sees mismatch, marks Violated, returns false
 *     - Hook reverts on IntentMismatch
 *     - Tx-level revert rolls back the Violated transition
 *  3. WATCHER decodes the failed swap tx, computes the actionData the hook
 *     would have passed, and calls Pulse.reveal DIRECTLY (no hook in the loop)
 *     - Status flips to Violated, slash sticks
 *
 * Run: bun run scripts/violation-and-rollback-demo.ts
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
const WATCHER_KEY = process.env.WATCHER_KEY! as Hex;
const AGENT_ID = BigInt(process.env.AGENT_ID!);

const agent = privateKeyToAccount(AGENT_KEY);
const tee = privateKeyToAccount(TEE_KEY);
const watcher = privateKeyToAccount(WATCHER_KEY);

const publicClient = createPublicClient({chain: baseSepolia, transport: http(RPC)});
const agentWallet = createWalletClient({account: agent, chain: baseSepolia, transport: http(RPC)});
const watcherWallet = createWalletClient({account: watcher, chain: baseSepolia, transport: http(RPC)});

const MIN_SQRT_PRICE = 4295128740n;
const STATUS_LABELS = ["Pending", "Revealed", "Violated", "Expired"] as const;

const PULSE_ABI = parseAbi([
    "function commit(uint256 agentId, bytes32 intentHash, bytes32 reasoningCID, uint64 executeAfter, uint64 revealWindow, address signerProvider, bytes sealedSig) returns (uint256 id)",
    "function reveal(uint256 id, bytes32 nonce, bytes actionData) returns (bool kept)",
    "function getStatus(uint256 id) view returns (uint8)",
    "event Committed(uint256 indexed id, uint256 indexed agentId, bytes32 intentHash, bytes32 reasoningCID, uint64 executeAfter, uint64 revealWindow, address signerProvider)",
    "event Violated(uint256 indexed id, uint256 indexed agentId)"
]);

const SWAP_ROUTER_ABI = parseAbi([
    "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
    "struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }",
    "struct TestSettings { bool takeClaims; bool settleUsingBurn; }",
    "function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) returns (int256)"
]);

const poolKey = {
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: HOOK
} as const;

// Honest params Y the agent commits to
const honestParams = {
    zeroForOne: true,
    amountSpecified: -parseEther("0.01"),
    sqrtPriceLimitX96: MIN_SQRT_PRICE
} as const;

// Cheating params Y' the agent actually tries to swap with (different amount)
const cheatingParams = {
    zeroForOne: true,
    amountSpecified: -parseEther("0.05"),
    sqrtPriceLimitX96: MIN_SQRT_PRICE
} as const;

const testSettings = {takeClaims: false, settleUsingBurn: false} as const;

function encodeActionData(params: typeof honestParams): Hex {
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
        [poolKey, params]
    );
}

async function readStatus(id: bigint, expectStatus?: number): Promise<number> {
    for (let attempt = 0; attempt < 8; attempt++) {
        const status = Number(
            await publicClient.readContract({address: PULSE, abi: PULSE_ABI, functionName: "getStatus", args: [id]})
        );
        if (expectStatus === undefined || status === expectStatus) return status;
        await new Promise((r) => setTimeout(r, 1500));
    }
    return Number(
        await publicClient.readContract({address: PULSE, abi: PULSE_ABI, functionName: "getStatus", args: [id]})
    );
}

async function buildAndCommit() {
    const honestActionData = encodeActionData(honestParams);
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    const intentHash = keccak256(encodePacked(["bytes32", "bytes"], [nonce, honestActionData]));
    const reasoningCID = `0x${randomBytes(32).toString("hex")}` as Hex;

    const block = await publicClient.getBlock({blockTag: "latest"});
    const executeAfter = block.timestamp + 5n;
    const revealWindow = 600n;

    const payload = keccak256(
        encodeAbiParameters(
            [{type: "uint256"}, {type: "bytes32"}, {type: "bytes32"}, {type: "uint64"}],
            [AGENT_ID, intentHash, reasoningCID, executeAfter]
        )
    );
    const sealedSig = await tee.signMessage({message: {raw: payload}});

    const data = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "commit",
        args: [AGENT_ID, intentHash, reasoningCID, executeAfter, revealWindow, tee.address, sealedSig]
    });
    const commitTx = await agentWallet.sendTransaction({to: PULSE, data});
    const receipt = await publicClient.waitForTransactionReceipt({hash: commitTx});

    let commitmentId: bigint | null = null;
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== PULSE.toLowerCase()) continue;
        if (log.topics[0]) commitmentId = BigInt(log.topics[1]!);
        if (commitmentId) break;
    }
    if (!commitmentId) throw new Error("Committed event not in receipt");

    return {commitmentId, nonce, intentHash, executeAfter, commitTx};
}

async function attemptCheatingSwap(args: {commitmentId: bigint; nonce: Hex; executeAfter: bigint}) {
    while (true) {
        const b = await publicClient.getBlock({blockTag: "latest"});
        if (b.timestamp > args.executeAfter) break;
        await new Promise((r) => setTimeout(r, 2_000));
    }

    const hookData = encodeAbiParameters(
        [{type: "uint256"}, {type: "bytes32"}],
        [args.commitmentId, args.nonce]
    );
    const data = encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "swap",
        args: [poolKey, cheatingParams, testSettings, hookData]
    });

    try {
        const txHash = await agentWallet.sendTransaction({to: SWAP_ROUTER, data, gas: 1_200_000n});
        const receipt = await publicClient.waitForTransactionReceipt({hash: txHash});
        return {txHash, status: receipt.status};
    } catch (err: any) {
        // viem throws on revert during simulation; that's the expected path.
        const msg = (err.shortMessage || err.message || "").split("\n")[0];
        return {txHash: null as Hex | null, status: "reverted" as const, error: msg};
    }
}

async function watcherSlashes(args: {commitmentId: bigint; nonce: Hex}) {
    // Watcher decodes the failed swap to recover (commitmentId, nonce, params Y').
    // For this demo we feed in the params we used; in production decodeFailedSwap()
    // pulls them out of the failed tx's calldata.
    const cheatingActionData = encodeActionData(cheatingParams);

    const data = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "reveal",
        args: [args.commitmentId, args.nonce, cheatingActionData]
    });
    const txHash = await watcherWallet.sendTransaction({to: PULSE, data, gas: 600_000n});
    const receipt = await publicClient.waitForTransactionReceipt({hash: txHash});
    return {txHash, status: receipt.status};
}

async function main() {
    console.log("══════════════════════════════════════════════════════════════════");
    console.log(" Violation + watcher-rollback demo");
    console.log("══════════════════════════════════════════════════════════════════");
    console.log(`  Pulse:    ${PULSE}`);
    console.log(`  Hook:     ${HOOK}`);
    console.log(`  Agent:    ${agent.address} (id=${AGENT_ID})`);
    console.log(`  Watcher:  ${watcher.address}`);

    // Step 1: AGENT commits to honestParams
    console.log("\n→ Step 1: AGENT commits to honestParams (amountSpecified=-0.01)");
    const {commitmentId, nonce, intentHash, executeAfter, commitTx} = await buildAndCommit();
    console.log(`  commit tx:    ${commitTx}`);
    console.log(`  commitmentId: ${commitmentId}`);
    console.log(`  intentHash:   ${intentHash}`);
    console.log(`  executeAfter: ${executeAfter}`);

    // Step 2: AGENT attempts swap with cheatingParams
    console.log("\n→ Step 2: AGENT attempts cheating swap (amountSpecified=-0.05) ");
    console.log("   waiting for executeAfter…");
    const cheatResult = await attemptCheatingSwap({commitmentId, nonce, executeAfter});

    if (cheatResult.txHash && cheatResult.status === "reverted") {
        console.log(`  ✓ cheating swap landed but reverted on chain: ${cheatResult.txHash}`);
    } else if (!cheatResult.txHash) {
        console.log(`  ✓ cheating swap rejected at simulation: ${cheatResult.error?.slice(0, 110)}`);
    } else {
        console.log(`  ❌ cheating swap unexpectedly succeeded: ${cheatResult.txHash}`);
        return process.exit(1);
    }

    // Step 3: post-revert, status SHOULD still be Pending (state rolled back with revert)
    const statusAfterRevert = await readStatus(commitmentId);
    console.log(`\n→ Step 3: status after rollback = ${STATUS_LABELS[statusAfterRevert]}`);
    if (statusAfterRevert !== 0) {
        console.log("  ⚠ unexpected: status is not Pending after the rollback");
    } else {
        console.log("  ✓ status is still Pending — rollback gap demonstrated");
    }

    // Step 4: WATCHER calls Pulse.reveal directly
    console.log("\n→ Step 4: WATCHER calls Pulse.reveal directly with the cheating actionData");
    const slashResult = await watcherSlashes({commitmentId, nonce});
    console.log(`  reveal tx:    ${slashResult.txHash}`);
    console.log(`  receipt:      ${slashResult.status}`);

    // Step 5: status should now be Violated
    const finalStatus = await readStatus(commitmentId, 2);
    console.log(`\n→ Step 5: final status = ${STATUS_LABELS[finalStatus]}`);
    const ok = finalStatus === 2;
    console.log(`  ${ok ? "✓" : "❌"} commitment ${ok ? "locked into Violated by watcher" : "did not transition"}`);

    console.log("\n══════════════════════════════════════════════════════════════════");
    console.log(" SUMMARY");
    console.log("══════════════════════════════════════════════════════════════════");
    console.log(`  Rollback gap: ${statusAfterRevert === 0 ? "✓ demonstrated" : "✗ not seen"}`);
    console.log(`  Watcher slash: ${ok ? "✓ status=Violated, slash applied" : "✗ failed"}`);
    if (!ok) process.exit(1);
}

main().catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
});
