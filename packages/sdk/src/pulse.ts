import {keccak256, encodePacked, encodeFunctionData, type Address, type Hex, type WalletClient, type PublicClient} from "viem";

import type {CommitInput, RevealInput} from "./types.js";

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
    }
] as const;

/// reveal/markExpired internally call ReputationRegistry.giveFeedback through
/// a try/catch. eth_estimateGas finds the OOG-success branch (catch swallows
/// the inner OOG) and quotes far less gas than the inner storage writes need.
/// Override these defaults per-call only if you've measured a tighter budget.
export const DEFAULT_REVEAL_GAS = 600_000n;
export const DEFAULT_MARK_EXPIRED_GAS = 500_000n;

export async function commitIntent(
    wallet: WalletClient,
    pulseAddress: Address,
    input: CommitInput
): Promise<Hex> {
    const intentHash = keccak256(encodePacked(["bytes32", "bytes"], [input.nonce, input.actionData]));

    const data = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "commit",
        args: [
            input.agentId,
            intentHash,
            input.reasoningCID,
            input.executeAfter,
            input.revealWindow,
            input.reasoning.signerAddress,
            input.reasoning.signature
        ]
    });

    const account = wallet.account;
    if (!account) throw new Error("wallet missing account");

    return wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: pulseAddress,
        data
    });
}

export async function revealIntent(
    wallet: WalletClient,
    pulseAddress: Address,
    input: RevealInput,
    opts: {gas?: bigint} = {}
): Promise<Hex> {
    const data = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "reveal",
        args: [input.commitmentId, input.nonce, input.actionData]
    });

    const account = wallet.account;
    if (!account) throw new Error("wallet missing account");

    return wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: pulseAddress,
        data,
        gas: opts.gas ?? DEFAULT_REVEAL_GAS
    });
}

export async function markExpiredIntent(
    wallet: WalletClient,
    pulseAddress: Address,
    commitmentId: bigint,
    opts: {gas?: bigint} = {}
): Promise<Hex> {
    const data = encodeFunctionData({
        abi: PULSE_ABI,
        functionName: "markExpired",
        args: [commitmentId]
    });

    const account = wallet.account;
    if (!account) throw new Error("wallet missing account");

    return wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: pulseAddress,
        data,
        gas: opts.gas ?? DEFAULT_MARK_EXPIRED_GAS
    });
}

export {PULSE_ABI};
