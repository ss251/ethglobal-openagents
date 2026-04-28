import type {Address, Hex} from "viem";

export interface Commitment {
    id: bigint;
    agentId: bigint;
    principal: Address;
    commitTime: bigint;
    executeAfter: bigint;
    revealDeadline: bigint;
    status: 0 | 1 | 2 | 3;
    intentHash: Hex;
    reasoningCID: Hex;
    signerProvider: Address;
}

export interface SealedReasoning {
    text: string;
    signature: Hex;
    signerAddress: Address;
    chatId: string;
}

export interface CommitInput {
    agentId: bigint;
    actionData: Hex;
    nonce: Hex;
    reasoning: SealedReasoning;
    reasoningCID: Hex;
    executeAfter: bigint;
    revealWindow: bigint;
}

export interface RevealInput {
    commitmentId: bigint;
    nonce: Hex;
    actionData: Hex;
}
