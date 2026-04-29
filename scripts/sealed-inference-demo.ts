/**
 * Sealed-inference → Pulse commitment, end-to-end, on Base Sepolia.
 *
 * Replaces the random reasoningCID stand-in with a content hash derived from
 * an actual 0G Compute call. Anyone can later re-pull the (prompt, response)
 * pair from the proxy provider and verify the hash matches what was committed.
 *
 * This is the path production agents follow:
 *   1. assemble structured prompt for the action they're considering
 *   2. call 0G TEE-attested qwen for reasoning
 *   3. hash (prompt + response) → reasoningCID
 *   4. derive intentHash from action params
 *   5. sign Pulse payload with TEE signer (stand-in here, real 0G TEE in prod)
 *   6. commit
 *
 * Run: bun run scripts/sealed-inference-demo.ts
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
    toHex,
    type Address,
    type Hex
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {randomBytes} from "node:crypto";

// ─── env ──────────────────────────────────────────────────────────────────
const RPC = process.env.BASE_SEPOLIA_RPC_URL!;
const PULSE = process.env.PULSE_ADDRESS! as Address;
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY! as Hex;
const TEE_KEY = process.env.DEMO_TEE_SIGNER_KEY! as Hex;
const AGENT_ID = BigInt(process.env.AGENT_ID!);

const ZG_API_KEY = process.env.ZG_API_KEY!;
const ZG_BROKER_URL = process.env.ZG_BROKER_URL!;
const ZG_MODEL = process.env.ZG_MODEL || "qwen/qwen-2.5-7b-instruct";
const ZG_SIGNER_ADDRESS = process.env.ZG_SIGNER_ADDRESS!;

if (!ZG_API_KEY || !ZG_BROKER_URL) {
    throw new Error("0G env not configured (ZG_API_KEY, ZG_BROKER_URL)");
}

const agent = privateKeyToAccount(AGENT_KEY);
const tee = privateKeyToAccount(TEE_KEY);
const zg = new OpenAI({apiKey: ZG_API_KEY, baseURL: ZG_BROKER_URL});

const publicClient = createPublicClient({chain: baseSepolia, transport: http(RPC)});
const walletClient = createWalletClient({account: agent, chain: baseSepolia, transport: http(RPC)});

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
        type: "event",
        name: "Committed",
        inputs: [
            {name: "id", type: "uint256", indexed: true},
            {name: "agentId", type: "uint256", indexed: true},
            {name: "intentHash", type: "bytes32"},
            {name: "reasoningCID", type: "bytes32"},
            {name: "executeAfter", type: "uint64"},
            {name: "revealWindow", type: "uint64"},
            {name: "signerProvider", type: "address"}
        ]
    }
] as const;

interface SwapIntent {
    direction: "buy" | "sell";
    base: string;
    quote: string;
    amount: string;
    minPrice: string;
}

function buildPrompt(intent: SwapIntent): {system: string; user: string} {
    return {
        system:
            "You are an autonomous trading agent. Reason about the intent below and output ONE concise paragraph (≤120 words) explaining whether to execute. Be specific about the price floor that protects the agent. End with a single line: DECISION: EXECUTE or DECISION: ABORT.",
        user: `Intent:
  Direction:  ${intent.direction}
  Base:       ${intent.base}
  Quote:      ${intent.quote}
  Amount:     ${intent.amount}
  Min price:  ${intent.minPrice}

Market context: stablecoin pair, low slippage tolerance, on-chain settlement via Uniswap v4.`
    };
}

async function callZG(prompt: {system: string; user: string}): Promise<{
    text: string;
    raw: any;
}> {
    const completion = await zg.chat.completions.create({
        model: ZG_MODEL,
        messages: [
            {role: "system", content: prompt.system},
            {role: "user", content: prompt.user}
        ],
        max_tokens: 256
    });
    const text = completion.choices[0]?.message?.content ?? "";
    return {text, raw: completion};
}

/// reasoningCID is the keccak hash over the canonical (prompt, response, model)
/// blob. Anyone can recompute it from the archived (prompt, response) and
/// confirm it matches what was committed on-chain.
function hashReasoning(args: {
    model: string;
    prompt: {system: string; user: string};
    response: string;
}): Hex {
    const blob = JSON.stringify({
        model: args.model,
        provider: ZG_SIGNER_ADDRESS,
        prompt: args.prompt,
        response: args.response
    });
    return keccak256(toHex(blob));
}

/// intentHash binds the agent to specific action parameters. For this demo we
/// hash the structured intent — in v4 swap demos this is `abi.encode(key, params)`.
function hashIntent(nonce: Hex, intent: SwapIntent): Hex {
    const intentBlob = JSON.stringify(intent);
    return keccak256(encodePacked(["bytes32", "bytes"], [nonce, toHex(intentBlob)]));
}

async function commit(args: {
    intentHash: Hex;
    reasoningCID: Hex;
    executeAfter: bigint;
    revealWindow: bigint;
}): Promise<{commitmentId: bigint; commitTx: Hex}> {
    const payload = keccak256(
        encodeAbiParameters(
            [{type: "uint256"}, {type: "bytes32"}, {type: "bytes32"}, {type: "uint64"}],
            [AGENT_ID, args.intentHash, args.reasoningCID, args.executeAfter]
        )
    );
    const sealedSig = await tee.signMessage({message: {raw: payload}});

    const data = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "commit",
        args: [
            AGENT_ID,
            args.intentHash,
            args.reasoningCID,
            args.executeAfter,
            args.revealWindow,
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
    if (!commitmentId) throw new Error("commit didn't emit Committed");
    return {commitmentId, commitTx};
}

async function main() {
    console.log("══════════════════════════════════════════════════════════════════");
    console.log(" Sealed inference → Pulse commitment");
    console.log("══════════════════════════════════════════════════════════════════");
    console.log(`  Pulse:    ${PULSE}`);
    console.log(`  Agent:    ${agent.address} (id=${AGENT_ID})`);
    console.log(`  TEE sig:  ${tee.address}  (stand-in; production uses 0G TEE attestation)`);
    console.log(`  Provider: ${ZG_SIGNER_ADDRESS}`);
    console.log(`  Model:    ${ZG_MODEL}`);

    const intent: SwapIntent = {
        direction: "sell",
        base: "pETH",
        quote: "pUSD",
        amount: "0.01",
        minPrice: "1800.0"
    };
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;

    console.log("\n→ Calling 0G qwen for reasoning…");
    const prompt = buildPrompt(intent);
    const {text, raw} = await callZG(prompt);
    console.log("\n--- model output ---");
    console.log(text);
    console.log("--------------------");
    console.log(`  tokens: prompt=${raw.usage?.prompt_tokens} completion=${raw.usage?.completion_tokens}`);

    const reasoningCID = hashReasoning({model: ZG_MODEL, prompt, response: text});
    const intentHash = hashIntent(nonce, intent);

    console.log(`\n  intentHash:    ${intentHash}`);
    console.log(`  reasoningCID:  ${reasoningCID}`);
    console.log(`  nonce:         ${nonce}`);

    const block = await publicClient.getBlock({blockTag: "latest"});
    const executeAfter = block.timestamp + 30n;
    const revealWindow = 600n;

    console.log("\n→ Committing on-chain…");
    const {commitmentId, commitTx} = await commit({intentHash, reasoningCID, executeAfter, revealWindow});
    console.log(`  commit tx:     ${commitTx}`);
    console.log(`  commitmentId:  ${commitmentId}`);
    console.log(`  executeAfter:  ${executeAfter} (${new Date(Number(executeAfter) * 1000).toISOString()})`);
    console.log(`\nCommitment is live. Reasoning is anchored on-chain via reasoningCID.`);
    console.log(`Anyone can re-pull the (prompt, response) blob from 0G and verify the hash.`);
}

main().catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
});
