/**
 * Helpers wrapping Pulse contract reads + the action-data + commitment-sig
 * primitives that every Pulse-bound script needs.
 */

import {
    type Address,
    type Hex,
    type PublicClient,
    type LocalAccount,
    encodeAbiParameters,
    keccak256
} from "viem";
import {PULSE_ABI, STATUS_LABELS, type StatusLabel} from "./abi";

export interface CommitmentView {
    id: bigint;
    agentId: bigint;
    principal: Address;
    commitTime: bigint;
    executeAfter: bigint;
    revealDeadline: bigint;
    status: number;
    statusLabel: StatusLabel;
    intentHash: Hex;
    reasoningCID: Hex;
    signerProvider: Address;
    /** computed convenience flags */
    inRevealWindow: boolean;
    overdueExpired: boolean;
}

export async function readCommitment(
    publicClient: PublicClient,
    pulse: Address,
    id: bigint
): Promise<CommitmentView> {
    const c = (await publicClient.readContract({
        address: pulse,
        abi: PULSE_ABI,
        functionName: "getCommitment",
        args: [id]
    })) as readonly [
        bigint, // agentId
        Address, // principal
        bigint, // commitTime
        bigint, // executeAfter
        bigint, // revealDeadline
        number, // status
        Hex, // intentHash
        Hex, // reasoningCID
        Address // signerProvider
    ];

    const [agentId, principal, commitTime, executeAfter, revealDeadline, status, intentHash, reasoningCID, signerProvider] = c;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const inRevealWindow = now >= executeAfter && now < revealDeadline && status === 0;
    const overdueExpired = now >= revealDeadline && status === 0;

    return {
        id,
        agentId,
        principal,
        commitTime,
        executeAfter,
        revealDeadline,
        status,
        statusLabel: STATUS_LABELS[status] ?? ("Pending" as StatusLabel),
        intentHash,
        reasoningCID,
        signerProvider,
        inRevealWindow,
        overdueExpired
    };
}

export async function readStatus(
    publicClient: PublicClient,
    pulse: Address,
    id: bigint
): Promise<{code: number; label: StatusLabel}> {
    const code = Number(
        await publicClient.readContract({
            address: pulse,
            abi: PULSE_ABI,
            functionName: "getStatus",
            args: [id]
        })
    );
    return {code, label: STATUS_LABELS[code] ?? "Pending"};
}

/**
 * Sign the commitment payload that Pulse expects from the TEE/signer
 * provider. The hash matches `_commitmentDigest` in Pulse.sol.
 */
export async function signCommitmentPayload(
    signer: LocalAccount,
    args: {
        agentId: bigint;
        intentHash: Hex;
        reasoningCID: Hex;
        executeAfter: bigint;
    }
): Promise<Hex> {
    const payload = keccak256(
        encodeAbiParameters(
            [{type: "uint256"}, {type: "bytes32"}, {type: "bytes32"}, {type: "uint64"}],
            [args.agentId, args.intentHash, args.reasoningCID, args.executeAfter]
        )
    );
    return signer.signMessage({message: {raw: payload}});
}

/** Encode (PoolKey, SwapParams) the same way the hook expects in actionData. */
export function encodeActionData(
    poolKey: {
        currency0: Address;
        currency1: Address;
        fee: number;
        tickSpacing: number;
        hooks: Address;
    },
    swapParams: {zeroForOne: boolean; amountSpecified: bigint; sqrtPriceLimitX96: bigint}
): Hex {
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

/** hookData = abi.encode(commitmentId, nonce). Used in the swap call. */
export function encodeHookData(commitmentId: bigint, nonce: Hex): Hex {
    return encodeAbiParameters(
        [{type: "uint256"}, {type: "bytes32"}],
        [commitmentId, nonce]
    );
}

/** Find the Committed event log inside a tx receipt and return the id. */
export function extractCommitmentId(
    pulseAddress: Address,
    logs: readonly {address: Address; topics: readonly Hex[]}[]
): bigint | null {
    for (const log of logs) {
        if (log.address.toLowerCase() !== pulseAddress.toLowerCase()) continue;
        const idTopic = log.topics[1];
        if (!idTopic) continue;
        return BigInt(idTopic);
    }
    return null;
}
