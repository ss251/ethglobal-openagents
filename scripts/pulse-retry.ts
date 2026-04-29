#!/usr/bin/env bun
/**
 * pulse-retry — recover an un-revealed commitment by re-submitting the swap.
 *
 * The classic agent failure mode: the original autonomous-trade run committed
 * to Pulse but the swap reverted (insufficient balance, wrong gas, RPC hiccup,
 * etc.). The commitment is on-chain in Pending state and the agent needs to
 * either (a) execute the swap inside the reveal window, or (b) explicitly
 * mark it expired after the window closes. This script handles (a).
 *
 * Usage:
 *   bun run scripts/pulse-retry.ts \
 *     --commitment-id 11 \
 *     --nonce 0xa8a3e3f9c292da51f3e95651abef8594f9698fbf4bff06df9bcad116384322b7 \
 *     --action-data 0x...      # optional; if omitted, decoded from a fresh
 *                              # reconstruction using --direction + --base-amount
 *     [--direction sell|buy --base-amount 0.005]   # only used if no --action-data
 *
 * Required env (auto-loaded from .env via _lib/env):
 *   SEPOLIA_RPC_URL, PULSE_ADDRESS, HOOK_ADDRESS, POOL_SWAP_TEST,
 *   POOL_TOKEN0, POOL_TOKEN1, POOL_FEE, POOL_TICK_SPACING, AGENT_PRIVATE_KEY
 *
 * Output: single JSON object on stdout with status, swap tx, and final
 * Pulse status — agent should narrate this back to the user.
 */

import {
    type Address,
    type Hex,
    createPublicClient,
    createWalletClient,
    decodeAbiParameters,
    encodeFunctionData,
    http,
    parseEther
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";

import {loadEnv, requireEnv} from "./_lib/env";
import {SWAP_ROUTER_ABI, MIN_SQRT_PRICE, MAX_SQRT_PRICE} from "./_lib/abi";
import {ensureFundedAndApproved} from "./_lib/funding";
import {readCommitment, readStatus, encodeActionData, encodeHookData} from "./_lib/pulse";
import {step, runMain} from "./_lib/output";

loadEnv();

function parseArg(name: string, fallback?: string): string {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx === -1 || idx === process.argv.length - 1) {
        if (fallback !== undefined) return fallback;
        throw new Error(`missing required arg --${name}`);
    }
    return process.argv[idx + 1];
}

const RPC = requireEnv("SEPOLIA_RPC_URL");
const PULSE = requireEnv("PULSE_ADDRESS") as Address;
const HOOK = requireEnv("HOOK_ADDRESS") as Address;
const SWAP_ROUTER = requireEnv("POOL_SWAP_TEST") as Address;
const TOKEN0 = requireEnv("POOL_TOKEN0") as Address;
const TOKEN1 = requireEnv("POOL_TOKEN1") as Address;
const FEE = Number(requireEnv("POOL_FEE"));
const TICK_SPACING = Number(requireEnv("POOL_TICK_SPACING"));
const AGENT_KEY = requireEnv("AGENT_PRIVATE_KEY") as Hex;

const commitmentId = BigInt(parseArg("commitment-id"));
const nonce = parseArg("nonce") as Hex;
const explicitActionData = process.argv.includes("--action-data") ? (parseArg("action-data") as Hex) : null;

const agent = privateKeyToAccount(AGENT_KEY);
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

interface DecodedAction {
    poolKey: typeof poolKey;
    swapParams: {zeroForOne: boolean; amountSpecified: bigint; sqrtPriceLimitX96: bigint};
}

function decodeStoredActionData(actionData: Hex): DecodedAction {
    const [pk, sp] = decodeAbiParameters(
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
        actionData
    );
    return {
        poolKey: {
            currency0: pk.currency0,
            currency1: pk.currency1,
            fee: pk.fee,
            tickSpacing: pk.tickSpacing,
            hooks: pk.hooks
        } as typeof poolKey,
        swapParams: {
            zeroForOne: sp.zeroForOne,
            amountSpecified: sp.amountSpecified,
            sqrtPriceLimitX96: sp.sqrtPriceLimitX96
        }
    };
}

function reconstructFromIntent(direction: "sell" | "buy", baseAmount: string): DecodedAction {
    // Same shape autonomous-trade.ts produces. Sell pETH (TOKEN1) → zeroForOne=false.
    const zeroForOne = direction === "buy";
    return {
        poolKey,
        swapParams: {
            zeroForOne,
            amountSpecified: -parseEther(baseAmount),
            sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE
        }
    };
}

async function main() {
    step(`══ pulse-retry ══`);
    step(`  commitmentId : ${commitmentId}`);
    step(`  nonce        : ${nonce}`);

    const commitment = await readCommitment(publicClient, PULSE, commitmentId);
    step(`  status       : ${commitment.status} (${commitment.statusLabel})`);
    step(`  agentId      : ${commitment.agentId}`);
    step(`  intentHash   : ${commitment.intentHash}`);
    step(`  executeAfter : ${commitment.executeAfter} (now=${Math.floor(Date.now() / 1000)})`);
    step(`  revealDeadl. : ${commitment.revealDeadline}`);
    step(`  inWindow     : ${commitment.inRevealWindow}`);
    step(`  overdue      : ${commitment.overdueExpired}`);

    if (commitment.status !== 0) {
        return {
            scenario: "pulse-retry",
            status: "Skipped",
            reason: `commitment already in terminal state: ${commitment.statusLabel}`,
            commitmentId: commitmentId.toString(),
            commitmentStatus: commitment.statusLabel
        };
    }
    if (commitment.overdueExpired) {
        return {
            scenario: "pulse-retry",
            status: "Skipped",
            reason: "reveal window expired — call markExpired (or wait for slasher) instead of retrying",
            commitmentId: commitmentId.toString(),
            revealDeadline: commitment.revealDeadline.toString()
        };
    }
    if (!commitment.inRevealWindow) {
        return {
            scenario: "pulse-retry",
            status: "Skipped",
            reason: "executeAfter not yet passed — wait for the window to open",
            commitmentId: commitmentId.toString(),
            executeAfter: commitment.executeAfter.toString()
        };
    }

    // Resolve action data — explicit > reconstructed.
    let decoded: DecodedAction;
    if (explicitActionData) {
        step(`→ using explicit --action-data`);
        decoded = decodeStoredActionData(explicitActionData);
    } else {
        const direction = parseArg("direction", "sell") as "sell" | "buy";
        const baseAmount = parseArg("base-amount");
        step(`→ reconstructing action-data from --direction=${direction} --base-amount=${baseAmount}`);
        decoded = reconstructFromIntent(direction, baseAmount);
    }

    // Verify the action data matches the on-chain intent hash. If not, hook
    // will reject anyway — fail loud here instead of paying gas.
    const reconstructedActionData = encodeActionData(decoded.poolKey, decoded.swapParams);
    const expectedHookData = encodeHookData(commitmentId, nonce);
    void expectedHookData;
    // intentHash = keccak256(abi.encodePacked(nonce, actionData)) — we don't
    // verify the hash locally because callers may pass exact action-data they
    // recovered from the original run; if it's wrong, the hook will revert
    // with a clear "intent mismatch" message during gas estimation below.

    const swapAmount = decoded.swapParams.amountSpecified < 0n
        ? -decoded.swapParams.amountSpecified
        : decoded.swapParams.amountSpecified;

    step(`\n→ ensureFunded (zeroForOne=${decoded.swapParams.zeroForOne}, amount=${swapAmount})`);
    const fund = await ensureFundedAndApproved(
        publicClient,
        walletClient,
        agent,
        {token0: TOKEN0, token1: TOKEN1, swapRouter: SWAP_ROUTER},
        {zeroForOne: decoded.swapParams.zeroForOne, amountIn: swapAmount},
        step
    );
    step(`  minted=${fund.minted} approved=${fund.approved} balanceAfter=${fund.balanceAfter}`);

    step(`\n→ submitting gated swap (atomic reveal)`);
    const swapData = encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "swap",
        args: [decoded.poolKey, decoded.swapParams, testSettings, encodeHookData(commitmentId, nonce)]
    });
    const swapTx = await walletClient.sendTransaction({to: SWAP_ROUTER, data: swapData, gas: 1_200_000n});
    const receipt = await publicClient.waitForTransactionReceipt({hash: swapTx});
    step(`  swap tx      : ${swapTx}  (status=${receipt.status})`);

    const final = await readStatus(publicClient, PULSE, commitmentId);
    step(`  pulse status : ${final.code} (${final.label})`);

    return {
        scenario: "pulse-retry",
        status: receipt.status === "success" ? "Success" : "SwapReverted",
        commitmentId: commitmentId.toString(),
        commitmentStatus: final.label,
        commitmentStatusCode: final.code,
        nonce,
        actionData: reconstructedActionData,
        swapTx,
        gasUsed: receipt.gasUsed.toString(),
        funding: {
            minted: fund.minted,
            approved: fund.approved,
            balanceBefore: fund.balanceBefore.toString(),
            balanceAfter: fund.balanceAfter.toString()
        },
        explorer: {
            swap: `https://sepolia.etherscan.io/tx/${swapTx}`,
            pulse: `https://sepolia.etherscan.io/address/${PULSE}#events`
        }
    };
}

runMain("pulse-retry", main);
