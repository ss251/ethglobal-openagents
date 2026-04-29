/**
 * watch-and-slash.ts
 *
 * Closes the atomic-reveal rollback gap (see SPEC.md "Atomic-reveal rollback note").
 *
 * The problem: when PulseGatedHook reverts on intent mismatch inside beforeSwap,
 * the entire transaction reverts — including Pulse's transition to Violated.
 * Without this watcher, a malicious agent can repeatedly attempt mismatched swaps
 * with no reputation cost (the hook reverts, the would-be slash never persists).
 *
 * The fix: a watcher service that listens for failed swap transactions targeting
 * pools wired with our hook. When it sees an IntentMismatch revert, it inspects
 * the swap's hookData (commitmentId + nonce) and the actual swap params (key + params),
 * then calls Pulse.reveal(commitmentId, nonce, abi.encode(key, params)) DIRECTLY — outside
 * the hook flow. The mismatch is detected, the hash check fails, status flips to
 * Violated, and the ERC-8004 -1000 slash sticks because there's no parent transaction
 * to roll back.
 *
 * Run as a long-lived service (or a cron):
 *   bun run scripts/watch-and-slash.ts
 *
 * Required env: WATCHER_KEY, SEPOLIA_RPC_URL, PULSE_ADDRESS, HOOK_ADDRESS, POOL_MANAGER.
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    decodeAbiParameters,
    decodeEventLog,
    parseAbi,
    type Address,
    type Hex,
    type Log
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";

import {PULSE_ABI} from "../packages/sdk/src/pulse.js";

const RPC = process.env.SEPOLIA_RPC_URL!;
const WATCHER_KEY = process.env.WATCHER_KEY as `0x${string}`;
const PULSE_ADDRESS = process.env.PULSE_ADDRESS as Address;
const HOOK_ADDRESS = process.env.HOOK_ADDRESS as Address;
const POOL_MANAGER = process.env.POOL_MANAGER as Address;

if (!RPC || !WATCHER_KEY || !PULSE_ADDRESS || !HOOK_ADDRESS || !POOL_MANAGER) {
    console.error("Missing env. Need SEPOLIA_RPC_URL, WATCHER_KEY, PULSE_ADDRESS, HOOK_ADDRESS, POOL_MANAGER.");
    process.exit(1);
}

const account = privateKeyToAccount(WATCHER_KEY);
const publicClient = createPublicClient({chain: sepolia, transport: http(RPC)});
const walletClient = createWalletClient({account, chain: sepolia, transport: http(RPC)});

/// Pool key + swap params encoding the hook recomputes — must match the
/// onchain encoding in PulseGatedHook._beforeSwap (abi.encode(key, params)).
const POOL_KEY_ABI = [
    {
        type: "tuple",
        components: [
            {name: "currency0", type: "address"},
            {name: "currency1", type: "address"},
            {name: "fee", type: "uint24"},
            {name: "tickSpacing", type: "int24"},
            {name: "hooks", type: "address"}
        ]
    }
] as const;

const SWAP_PARAMS_ABI = [
    {
        type: "tuple",
        components: [
            {name: "zeroForOne", type: "bool"},
            {name: "amountSpecified", type: "int256"},
            {name: "sqrtPriceLimitX96", type: "uint160"}
        ]
    }
] as const;

/// PoolManager.swap selector — when we see a failed tx with this selector
/// targeting our hook'd pool, it's a candidate for slash-on-mismatch.
const POOL_MANAGER_ABI = parseAbi([
    "function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, bytes hookData) returns (int256)"
]);

interface FailedSwap {
    txHash: Hex;
    commitmentId: bigint;
    nonce: Hex;
    actionData: Hex;
}

/// Decode a failed swap tx to extract the (commitmentId, nonce, actionData) we
/// need for a direct Pulse.reveal call.
async function decodeFailedSwap(txHash: Hex): Promise<FailedSwap | null> {
    try {
        const tx = await publicClient.getTransaction({hash: txHash});
        if (!tx.input || tx.to?.toLowerCase() !== POOL_MANAGER.toLowerCase()) return null;

        // Decode the swap calldata
        const decoded = decodeAbiParameters(
            [
                {type: "bytes4"}, // selector
                ...POOL_KEY_ABI,
                ...SWAP_PARAMS_ABI,
                {type: "bytes"} // hookData
            ],
            tx.input as Hex
        );

        // The call format is: selector || abi.encode(key, params, hookData)
        // We index past the 4-byte selector when decoding the rest.
        const [, key, params, hookData] = decoded as unknown as [
            Hex,
            {currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address},
            {zeroForOne: boolean; amountSpecified: bigint; sqrtPriceLimitX96: bigint},
            Hex
        ];

        // Confirm the swap was routed to our hook
        if (key.hooks.toLowerCase() !== HOOK_ADDRESS.toLowerCase()) return null;
        if (!hookData || hookData === "0x" || hookData.length < 130 /* 64 bytes minimum */) return null;

        const [commitmentId, nonce] = decodeAbiParameters(
            [{type: "uint256"}, {type: "bytes32"}],
            hookData
        );

        // The actionData the hook recomputed is abi.encode(key, params).
        // We re-encode it here so Pulse.reveal sees the same bytes.
        const actionData = encodeKeyAndParams(key, params);

        return {
            txHash,
            commitmentId: commitmentId as bigint,
            nonce: nonce as Hex,
            actionData
        };
    } catch (err) {
        console.warn(`decodeFailedSwap(${txHash}) failed:`, err);
        return null;
    }
}

function encodeKeyAndParams(
    key: {currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address},
    params: {zeroForOne: boolean; amountSpecified: bigint; sqrtPriceLimitX96: bigint}
): Hex {
    const {encodeAbiParameters} = require("viem") as typeof import("viem");
    return encodeAbiParameters(
        [
            ...POOL_KEY_ABI,
            ...SWAP_PARAMS_ABI
        ],
        [key, params]
    );
}

/// Call Pulse.reveal directly outside any hook flow. If the data mismatches
/// the committed hash, status flips to Violated and ERC-8004 slash fires.
/// If the data DID match the commitment (so the hook revert was due to
/// something else — wrong status, expired window — this just reverts harmlessly).
async function slashOnMismatch(swap: FailedSwap): Promise<void> {
    console.log(`[slash] commitmentId=${swap.commitmentId}, txHash=${swap.txHash}`);

    // First check the commitment is still Pending — if it already moved to
    // Violated/Revealed/Expired, no point in trying.
    const status = (await publicClient.readContract({
        address: PULSE_ADDRESS,
        abi: PULSE_ABI,
        functionName: "getStatus" as never,
        args: [swap.commitmentId]
    })) as number;

    if (status !== 0 /* Pending */) {
        console.log(`[slash] commitment ${swap.commitmentId} is no longer Pending (status=${status}); skipping`);
        return;
    }

    try {
        const txHash = await walletClient.writeContract({
            address: PULSE_ADDRESS,
            abi: PULSE_ABI,
            functionName: "reveal" as never,
            args: [swap.commitmentId, swap.nonce, swap.actionData] as never
        });
        console.log(`[slash] reveal tx submitted: ${txHash}`);

        const receipt = await publicClient.waitForTransactionReceipt({hash: txHash});
        // Look for Violated event
        const violated = receipt.logs.find((log: Log) => {
            try {
                const decoded = decodeEventLog({abi: PULSE_ABI, data: log.data, topics: log.topics});
                return decoded.eventName === "Violated";
            } catch {
                return false;
            }
        });
        if (violated) {
            console.log(`[slash] ✅ commitment ${swap.commitmentId} locked into Violated`);
        } else {
            console.log(`[slash] ⚠️ commitment ${swap.commitmentId} reveal landed but no Violated event (data may have matched after all)`);
        }
    } catch (err) {
        console.warn(`[slash] reveal call failed for commitment ${swap.commitmentId}:`, err);
    }
}

async function main() {
    console.log("watch-and-slash starting...");
    console.log(`  watcher:      ${account.address}`);
    console.log(`  pulse:        ${PULSE_ADDRESS}`);
    console.log(`  hook:         ${HOOK_ADDRESS}`);
    console.log(`  poolManager:  ${POOL_MANAGER}`);

    // Subscribe to all blocks; for each block, scan transactions to PoolManager
    // for failed swaps targeting our hook'd pool.
    publicClient.watchBlocks({
        onBlock: async (block) => {
            const fullBlock = await publicClient.getBlock({blockHash: block.hash, includeTransactions: true});
            for (const tx of fullBlock.transactions) {
                if (typeof tx === "string") continue;
                if (tx.to?.toLowerCase() !== POOL_MANAGER.toLowerCase()) continue;

                const receipt = await publicClient.getTransactionReceipt({hash: tx.hash});
                if (receipt.status === "success") continue; // not a failed swap

                const swap = await decodeFailedSwap(tx.hash);
                if (!swap) continue;

                await slashOnMismatch(swap);
            }
        }
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
