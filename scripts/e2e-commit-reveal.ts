/**
 * End-to-end commit-reveal driver against deployed Pulse on Eth Sepolia.
 *
 * Runs three flows back-to-back:
 *   1. KEPT     — commit, wait window, reveal with matching data, +100 rep
 *   2. VIOLATED — commit, wait window, reveal with mismatched data, -1000 rep
 *   3. EXPIRED  — commit with short window, do nothing, anyone calls markExpired, -500 rep
 *
 * Uses the stand-in TEE signer (DEMO_TEE_SIGNER_KEY) to sign the canonical
 * commit payload via EIP-191 personal_sign. This is the same path the
 * production 0G integration uses — the contract's SignatureChecker doesn't
 * care whether the signer is an enclave-born key or a stand-in EOA.
 *
 * Run: bun run scripts/e2e-commit-reveal.ts
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    encodePacked,
    encodeAbiParameters,
    encodeFunctionData,
    decodeEventLog,
    type Address,
    type Hex
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";
import {randomBytes} from "node:crypto";

// Inline the parts of the ABI we need — avoids workspace import complexity
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
    },
    {
        type: "function",
        name: "reveal",
        stateMutability: "nonpayable",
        inputs: [
            {name: "id", type: "uint256"},
            {name: "nonce", type: "bytes32"},
            {name: "actionData", type: "bytes"}
        ],
        outputs: [{name: "kept", type: "bool"}]
    },
    {
        type: "function",
        name: "markExpired",
        stateMutability: "nonpayable",
        inputs: [{name: "id", type: "uint256"}],
        outputs: []
    },
    {
        type: "function",
        name: "getStatus",
        stateMutability: "view",
        inputs: [{name: "id", type: "uint256"}],
        outputs: [{type: "uint8"}]
    },
    {
        type: "function",
        name: "getCommitment",
        stateMutability: "view",
        inputs: [{name: "id", type: "uint256"}],
        outputs: [
            {
                type: "tuple",
                components: [
                    {name: "agentId", type: "uint256"},
                    {name: "principal", type: "address"},
                    {name: "commitTime", type: "uint64"},
                    {name: "executeAfter", type: "uint64"},
                    {name: "revealDeadline", type: "uint64"},
                    {name: "status", type: "uint8"},
                    {name: "intentHash", type: "bytes32"},
                    {name: "reasoningCID", type: "bytes32"},
                    {name: "signerProvider", type: "address"}
                ]
            }
        ]
    },
    {
        type: "event",
        name: "Committed",
        inputs: [
            {name: "id", type: "uint256", indexed: true},
            {name: "agentId", type: "uint256", indexed: true},
            {name: "intentHash", type: "bytes32", indexed: false},
            {name: "reasoningCID", type: "bytes32", indexed: false},
            {name: "executeAfter", type: "uint64", indexed: false},
            {name: "revealDeadline", type: "uint64", indexed: false},
            {name: "signerProvider", type: "address", indexed: false}
        ]
    },
    {
        type: "event",
        name: "Revealed",
        inputs: [
            {name: "id", type: "uint256", indexed: true},
            {name: "agentId", type: "uint256", indexed: true},
            {name: "actionData", type: "bytes", indexed: false}
        ]
    },
    {
        type: "event",
        name: "Violated",
        inputs: [
            {name: "id", type: "uint256", indexed: true},
            {name: "agentId", type: "uint256", indexed: true},
            {name: "computedHash", type: "bytes32", indexed: false}
        ]
    },
    {
        type: "event",
        name: "Expired",
        inputs: [
            {name: "id", type: "uint256", indexed: true},
            {name: "agentId", type: "uint256", indexed: true}
        ]
    }
] as const;

const REPUTATION_REGISTRY_ABI = [
    {
        type: "event",
        name: "NewFeedback",
        inputs: [
            {name: "agentId", type: "uint256", indexed: true},
            {name: "clientAddress", type: "address", indexed: true},
            {name: "feedbackIndex", type: "uint64", indexed: false},
            {name: "value", type: "int128", indexed: false},
            {name: "valueDecimals", type: "uint8", indexed: false},
            {name: "indexedTag1", type: "string", indexed: true},
            {name: "tag1", type: "string", indexed: false},
            {name: "tag2", type: "string", indexed: false},
            {name: "endpoint", type: "string", indexed: false},
            {name: "feedbackURI", type: "string", indexed: false},
            {name: "feedbackHash", type: "bytes32", indexed: false}
        ]
    }
] as const;

const STATUS_LABELS = ["Pending", "Revealed", "Violated", "Expired"] as const;

const RPC = process.env.SEPOLIA_RPC_URL!;
const PULSE = process.env.PULSE_ADDRESS! as Address;
const REPUTATION_REGISTRY = process.env.REPUTATION_REGISTRY! as Address;
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY! as Hex;
const TEE_KEY = process.env.DEMO_TEE_SIGNER_KEY! as Hex;
const AGENT_ID = BigInt(process.env.AGENT_ID!);

const agent = privateKeyToAccount(AGENT_PRIVATE_KEY);
const tee = privateKeyToAccount(TEE_KEY);

const publicClient = createPublicClient({chain: sepolia, transport: http(RPC)});
const walletClient = createWalletClient({account: agent, chain: sepolia, transport: http(RPC)});

console.log("══════════════════════════════════════════════════════════════════");
console.log(" Pulse e2e commit-reveal driver — Eth Sepolia (chainId 84532)");
console.log("══════════════════════════════════════════════════════════════════");
console.log(`  Pulse:           ${PULSE}`);
console.log(`  Agent wallet:    ${agent.address}`);
console.log(`  Agent id:        ${AGENT_ID}`);
console.log(`  TEE signer:      ${tee.address} (stand-in)`);
console.log(`  Reputation:      ${REPUTATION_REGISTRY}`);
console.log("");

interface RunResult {
    label: string;
    commitmentId: bigint;
    finalStatus: number;
    commitTx: Hex;
    closeTx: Hex;
    feedback?: {score: bigint; tag1: string; tag2: string};
}

async function buildAndCommit(opts: {
    actionData: Hex;
    executeAfterSec: bigint;
    revealWindowSec: bigint;
}): Promise<{
    commitmentId: bigint;
    nonce: Hex;
    actionData: Hex;
    commitTx: Hex;
    executeAfter: bigint;
    revealDeadline: bigint;
}> {
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    const intentHash = keccak256(encodePacked(["bytes32", "bytes"], [nonce, opts.actionData]));
    const reasoningCID = `0x${"0".repeat(64)}` as Hex;
    const executeAfter = BigInt(Math.floor(Date.now() / 1000)) + opts.executeAfterSec;

    // TEE signs the canonical Pulse payload via EIP-191 personal_sign
    const payload = keccak256(
        encodeAbiParameters(
            [{type: "uint256"}, {type: "bytes32"}, {type: "bytes32"}, {type: "uint64"}],
            [AGENT_ID, intentHash, reasoningCID, executeAfter]
        )
    );
    const signature = await tee.signMessage({message: {raw: payload}});

    const data = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "commit",
        args: [
            AGENT_ID,
            intentHash,
            reasoningCID,
            executeAfter,
            opts.revealWindowSec,
            tee.address,
            signature
        ]
    });

    const commitTx = await walletClient.sendTransaction({to: PULSE, data});
    console.log(`  → commit tx: ${commitTx}`);
    const receipt = await publicClient.waitForTransactionReceipt({hash: commitTx});

    let commitmentId: bigint | null = null;
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== PULSE.toLowerCase()) continue;
        try {
            const ev = decodeEventLog({abi: PULSE_ABI, data: log.data, topics: log.topics});
            if (ev.eventName === "Committed") {
                commitmentId = (ev.args as {id: bigint}).id;
                break;
            }
        } catch {}
    }
    if (commitmentId === null) throw new Error("Committed event not found in receipt");
    console.log(`  → commitmentId: ${commitmentId}`);
    return {
        commitmentId,
        nonce,
        actionData: opts.actionData,
        commitTx,
        executeAfter,
        revealDeadline: executeAfter + opts.revealWindowSec
    };
}

async function readStatus(id: bigint, expectNonPending = false): Promise<number> {
    // Public RPC nodes occasionally serve stale state for a beat after a tx
    // is mined. If the caller knows the status should have transitioned past
    // Pending (0), retry a few times before reporting the stale read.
    for (let attempt = 0; attempt < 6; attempt++) {
        const status = Number(
            await publicClient.readContract({address: PULSE, abi: PULSE_ABI, functionName: "getStatus", args: [id]})
        );
        if (!expectNonPending || status !== 0) return status;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return 0;
}

async function decodeReputationFeedback(receiptLogs: readonly {address: Address; data: Hex; topics: readonly Hex[]}[]) {
    for (const log of receiptLogs) {
        if (log.address.toLowerCase() !== REPUTATION_REGISTRY.toLowerCase()) continue;
        try {
            const ev = decodeEventLog({abi: REPUTATION_REGISTRY_ABI, data: log.data, topics: log.topics});
            if (ev.eventName === "NewFeedback") {
                const args = ev.args as {
                    value: bigint;
                    valueDecimals: number;
                    tag1: string;
                    tag2: string;
                    feedbackIndex: bigint;
                };
                return {
                    score: args.value,
                    decimals: args.valueDecimals,
                    tag1: args.tag1,
                    tag2: args.tag2,
                    feedbackIndex: args.feedbackIndex
                };
            }
        } catch {}
    }
    return undefined;
}

/// Poll the chain's *actual* block timestamp. block.timestamp is what
/// Pulse.reveal checks against — local clock can be ahead, leading to a
/// false TooEarly() revert.
async function waitUntilChainTime(unixSec: bigint, label: string) {
    const target = unixSec;
    while (true) {
        const block = await publicClient.getBlock({blockTag: "latest"});
        const chainNow = block.timestamp;
        if (chainNow >= target) {
            process.stdout.write(`\r  ⏳ ${label}: chainNow=${chainNow} ≥ target=${target} ✓\n`);
            return;
        }
        const remaining = Number(target - chainNow);
        process.stdout.write(`\r  ⏳ ${label}: chainNow=${chainNow} target=${target} (${remaining}s)... `);
        await new Promise((r) => setTimeout(r, Math.min(remaining + 1, 5) * 1000));
    }
}

// ─── Run 1: KEPT ──────────────────────────────────────────────────────────
async function runKept(): Promise<RunResult> {
    console.log("\n──────────────────────────────────────────────────────────────────");
    console.log(" RUN 1 / KEPT — commit + matching reveal → +100 rep");
    console.log("──────────────────────────────────────────────────────────────────");
    const actionData: Hex = "0x6b6570742d72756e";  // "kept-run"
    const {commitmentId, nonce, commitTx, executeAfter} = await buildAndCommit({
        actionData,
        executeAfterSec: 30n,
        revealWindowSec: 600n
    });
    const status0 = await readStatus(commitmentId);
    console.log(`  Status:       ${STATUS_LABELS[status0]}`);
    await waitUntilChainTime(executeAfter + 1n, "waiting for executeAfter");
    process.stdout.write("\n");

    const data = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "reveal",
        args: [commitmentId, nonce, actionData]
    });
    const revealTx = await walletClient.sendTransaction({to: PULSE, data, gas: 600_000n});
    console.log(`  → reveal tx: ${revealTx}`);
    const receipt = await publicClient.waitForTransactionReceipt({hash: revealTx});
    const finalStatus = await readStatus(commitmentId, true);
    console.log(`  Final status: ${STATUS_LABELS[finalStatus]}`);
    const feedback = await decodeReputationFeedback(receipt.logs);
    if (feedback) {
        console.log(`  ERC-8004 feedback: score=${feedback.score} tag1="${feedback.tag1}" tag2="${feedback.tag2}"`);
    } else {
        console.log(`  ⚠ no ERC-8004 feedback event detected (giveFeedback may have reverted silently)`);
    }
    return {label: "kept", commitmentId, finalStatus, commitTx, closeTx: revealTx, feedback};
}

// ─── Run 2: VIOLATED ──────────────────────────────────────────────────────
async function runViolated(): Promise<RunResult> {
    console.log("\n──────────────────────────────────────────────────────────────────");
    console.log(" RUN 2 / VIOLATED — commit, reveal with WRONG data → -1000 rep");
    console.log("──────────────────────────────────────────────────────────────────");
    const actionData: Hex = "0x636f6d6d69747465642d61637469";  // "committed-acti"
    const wrongData: Hex = "0xdeadbeef";
    const {commitmentId, nonce, commitTx, executeAfter} = await buildAndCommit({
        actionData,
        executeAfterSec: 30n,
        revealWindowSec: 600n
    });
    await waitUntilChainTime(executeAfter + 1n, "waiting for executeAfter");
    process.stdout.write("\n");

    const data = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "reveal",
        args: [commitmentId, nonce, wrongData]
    });
    const revealTx = await walletClient.sendTransaction({to: PULSE, data, gas: 600_000n});
    console.log(`  → reveal tx (wrong data): ${revealTx}`);
    const receipt = await publicClient.waitForTransactionReceipt({hash: revealTx});
    const finalStatus = await readStatus(commitmentId, true);
    console.log(`  Final status: ${STATUS_LABELS[finalStatus]}`);
    const feedback = await decodeReputationFeedback(receipt.logs);
    if (feedback) {
        console.log(`  ERC-8004 feedback: score=${feedback.score} tag1="${feedback.tag1}" tag2="${feedback.tag2}"`);
    }
    return {label: "violated", commitmentId, finalStatus, commitTx, closeTx: revealTx, feedback};
}

// ─── Run 3: EXPIRED ───────────────────────────────────────────────────────
async function runExpired(): Promise<RunResult> {
    console.log("\n──────────────────────────────────────────────────────────────────");
    console.log(" RUN 3 / EXPIRED — commit, do nothing, markExpired → -500 rep");
    console.log("──────────────────────────────────────────────────────────────────");
    const actionData: Hex = "0x6578706972652d72756e";
    const {commitmentId, commitTx, revealDeadline} = await buildAndCommit({
        actionData,
        // very short window: opens at +5s, closes at +35s. anyone can markExpired after that.
        executeAfterSec: 5n,
        revealWindowSec: 30n
    });
    await waitUntilChainTime(revealDeadline + 1n, "waiting past revealDeadline");
    process.stdout.write("\n");

    const data = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "markExpired",
        args: [commitmentId]
    });
    const expireTx = await walletClient.sendTransaction({to: PULSE, data, gas: 500_000n});
    console.log(`  → markExpired tx: ${expireTx}`);
    const receipt = await publicClient.waitForTransactionReceipt({hash: expireTx});
    const finalStatus = await readStatus(commitmentId, true);
    console.log(`  Final status: ${STATUS_LABELS[finalStatus]}`);
    const feedback = await decodeReputationFeedback(receipt.logs);
    if (feedback) {
        console.log(`  ERC-8004 feedback: score=${feedback.score} tag1="${feedback.tag1}" tag2="${feedback.tag2}"`);
    }
    return {label: "expired", commitmentId, finalStatus, commitTx, closeTx: expireTx, feedback};
}

async function main() {
    const results: RunResult[] = [];
    results.push(await runKept());
    results.push(await runViolated());
    results.push(await runExpired());

    console.log("\n══════════════════════════════════════════════════════════════════");
    console.log(" SUMMARY");
    console.log("══════════════════════════════════════════════════════════════════");
    for (const r of results) {
        const tag = r.feedback ? `${r.feedback.score} (${r.feedback.tag1}/${r.feedback.tag2})` : "—";
        console.log(
            `  ${r.label.padEnd(9)}  cid=${r.commitmentId}  status=${STATUS_LABELS[r.finalStatus]}  rep=${tag}`
        );
        console.log(`             commit: ${r.commitTx}`);
        console.log(`             close:  ${r.closeTx}`);
    }
}

main().catch((err) => {
    console.error("\n[FATAL]", err);
    process.exit(1);
});
