import {keccak256, encodeAbiParameters, recoverMessageAddress, type Hex, type Address} from "viem";

import type {SealedReasoning} from "./types.js";

/// Build the EIP-191 personal_sign payload that 0G provider TEEs sign.
/// Matches Pulse.sol's commit() verification:
///   keccak256(abi.encode(agentId, intentHash, reasoningCID, executeAfter))
export function buildSealedPayload(
    agentId: bigint,
    intentHash: Hex,
    reasoningCID: Hex,
    executeAfter: bigint
): Hex {
    return keccak256(
        encodeAbiParameters(
            [
                {type: "uint256"},
                {type: "bytes32"},
                {type: "bytes32"},
                {type: "uint64"}
            ],
            [agentId, intentHash, reasoningCID, executeAfter]
        )
    );
}

/// Wrap a raw 0G inference response into a SealedReasoning struct after
/// pulling the matching ZG-Res-Key signature from the broker.
export interface FetchSealedReasoningArgs {
    brokerUrl: string;
    chatId: string;
    model: string;
    signerAddress: Address;
    fetchImpl?: typeof fetch;
}

export async function fetchSealedReasoning(args: FetchSealedReasoningArgs): Promise<SealedReasoning> {
    const fetcher = args.fetchImpl ?? fetch;
    const url = `${args.brokerUrl}/v1/proxy/signature/${args.chatId}?model=${encodeURIComponent(args.model)}`;
    const res = await fetcher(url, {method: "GET", headers: {"content-type": "application/json"}});
    if (!res.ok) throw new Error(`broker signature fetch failed: ${res.status}`);
    const data = (await res.json()) as {text: string; signature: Hex};

    return {
        text: data.text,
        signature: data.signature,
        signerAddress: args.signerAddress,
        chatId: args.chatId
    };
}

export async function verifySealedReasoning(reasoning: SealedReasoning): Promise<boolean> {
    const recovered = await recoverMessageAddress({
        message: reasoning.text,
        signature: reasoning.signature
    });
    return recovered.toLowerCase() === reasoning.signerAddress.toLowerCase();
}

// Convenience re-export so callers don't need to keep two import lines.
export const sealedReason = {build: buildSealedPayload, fetch: fetchSealedReasoning, verify: verifySealedReasoning};
