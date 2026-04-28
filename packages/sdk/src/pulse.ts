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
    }
] as const;

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
    input: RevealInput
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
        data
    });
}

export {PULSE_ABI};
