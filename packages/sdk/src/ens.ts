/**
 * ENS Agent Identity helpers for Pulse.
 *
 * Each Pulse-registered agent owns an ENS name (e.g. `pulseagent.eth`)
 * whose text records expose the agent's full provenance:
 *
 *   text("agentId")        → ERC-8004 IdentityRegistry token id (decimal string)
 *   text("signerProvider") → TEE signer address (the one passed to Pulse.commit)
 *   text("pulseHistory")   → CID / URL pointing to the agent's commit history feed
 *   text("description")    → human-readable agent purpose
 *   text("avatar")         → standard ENS avatar URL
 *
 * Resolution flow:
 *   ENS name → resolver → text records → agent provenance
 *
 * Registration flow (parent zone owner only):
 *   1. Set the parent name's resolver to a Public Resolver
 *   2. Call resolver.setText() for each record
 *   3. Optionally setAddr(coinType=60, agentAddress) so the name resolves to an EVM address too
 */

import {
    type Address,
    type Hex,
    type WalletClient,
    type PublicClient,
    namehash,
    encodeFunctionData
} from "viem";
import {normalize} from "viem/ens";

const ENS_PUBLIC_RESOLVER_ABI = [
    {
        type: "function",
        name: "text",
        stateMutability: "view",
        inputs: [
            {name: "node", type: "bytes32"},
            {name: "key", type: "string"}
        ],
        outputs: [{type: "string"}]
    },
    {
        type: "function",
        name: "setText",
        stateMutability: "nonpayable",
        inputs: [
            {name: "node", type: "bytes32"},
            {name: "key", type: "string"},
            {name: "value", type: "string"}
        ],
        outputs: []
    },
    {
        type: "function",
        name: "addr",
        stateMutability: "view",
        inputs: [
            {name: "node", type: "bytes32"},
            {name: "coinType", type: "uint256"}
        ],
        outputs: [{type: "bytes"}]
    }
] as const;

export interface AgentENSRecord {
    name: string;
    address?: Address;
    agentId?: bigint;
    signerProvider?: Address;
    pulseHistory?: string;
    description?: string;
    avatar?: string;
}

export interface ResolveAgentArgs {
    client: PublicClient;
    name: string;
    /// ENS Public Resolver. Mainnet (also Base/L2 via L2 resolution): 0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63
    resolverAddress?: Address;
}

/// Public Resolver addresses per chain.  Mainnet ENS lives at the first;
/// the Sepolia ENS deployment uses a different resolver.  Pulse defaults
/// to Sepolia for the v0.1 testnet demo; pass `resolverAddress` explicitly
/// to override (e.g. when reading mainnet records).
///   Sepolia (chainId 11155111): 0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5
///   Mainnet (chainId 1):        0xF29100983E058B709F3D539b0c765937B804AC15
const DEFAULT_PUBLIC_RESOLVER: Address = "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5";

/// Resolve an agent's full provenance from its ENS name.
/// Reads address (coinType=60) + the four standard Pulse text records.
export async function resolveAgentByENS(args: ResolveAgentArgs): Promise<AgentENSRecord> {
    const {client, name} = args;
    const resolverAddress = args.resolverAddress ?? DEFAULT_PUBLIC_RESOLVER;
    const node = namehash(normalize(name));

    const [agentIdStr, signerProviderStr, pulseHistory, description, avatar, addrBytes] = await Promise.all([
        readText(client, resolverAddress, node, "agentId"),
        readText(client, resolverAddress, node, "signerProvider"),
        readText(client, resolverAddress, node, "pulseHistory"),
        readText(client, resolverAddress, node, "description"),
        readText(client, resolverAddress, node, "avatar"),
        readAddr(client, resolverAddress, node, 60n)
    ]);

    return {
        name,
        address: addrBytes && addrBytes !== "0x" ? (`0x${addrBytes.slice(-40)}` as Address) : undefined,
        agentId: agentIdStr ? BigInt(agentIdStr) : undefined,
        signerProvider: (signerProviderStr || undefined) as Address | undefined,
        pulseHistory: pulseHistory || undefined,
        description: description || undefined,
        avatar: avatar || undefined
    };
}

async function readText(
    client: PublicClient,
    resolver: Address,
    node: Hex,
    key: string
): Promise<string> {
    try {
        const result = await client.readContract({
            address: resolver,
            abi: ENS_PUBLIC_RESOLVER_ABI,
            functionName: "text",
            args: [node, key]
        });
        return result as string;
    } catch {
        return "";
    }
}

async function readAddr(
    client: PublicClient,
    resolver: Address,
    node: Hex,
    coinType: bigint
): Promise<Hex> {
    try {
        const result = await client.readContract({
            address: resolver,
            abi: ENS_PUBLIC_RESOLVER_ABI,
            functionName: "addr",
            args: [node, coinType]
        });
        return result as Hex;
    } catch {
        return "0x";
    }
}

export interface SetAgentRecordsArgs {
    wallet: WalletClient;
    name: string;
    records: Partial<{
        agentId: bigint;
        signerProvider: Address;
        pulseHistory: string;
        description: string;
        avatar: string;
    }>;
    resolverAddress?: Address;
}

/// Set the standard Pulse text records on an ENS name. Caller MUST own the name
/// (or have a delegated controller). Returns the array of tx hashes (one per
/// non-empty record). Run only on chains where the resolver supports setText.
export async function setAgentENSRecords(args: SetAgentRecordsArgs): Promise<Hex[]> {
    const {wallet, name, records} = args;
    const resolverAddress = args.resolverAddress ?? DEFAULT_PUBLIC_RESOLVER;
    const node = namehash(normalize(name));
    const account = wallet.account;
    if (!account) throw new Error("wallet missing account");

    const writes: Array<{key: string; value: string}> = [];
    if (records.agentId !== undefined) writes.push({key: "agentId", value: records.agentId.toString()});
    if (records.signerProvider) writes.push({key: "signerProvider", value: records.signerProvider});
    if (records.pulseHistory) writes.push({key: "pulseHistory", value: records.pulseHistory});
    if (records.description) writes.push({key: "description", value: records.description});
    if (records.avatar) writes.push({key: "avatar", value: records.avatar});

    const txs: Hex[] = [];
    for (const {key, value} of writes) {
        const data = encodeFunctionData({
            abi: ENS_PUBLIC_RESOLVER_ABI,
            functionName: "setText",
            args: [node, key, value]
        });
        const hash = await wallet.sendTransaction({
            account,
            chain: wallet.chain,
            to: resolverAddress,
            data
        });
        txs.push(hash);
    }

    return txs;
}

/// Convenience: given an ENS name, return everything Pulse needs to make a
/// commitment on behalf of (or verify the provenance of) the agent.
export async function pulseProvenanceFromENS(args: ResolveAgentArgs): Promise<{
    agentId: bigint;
    address: Address;
    signerProvider: Address;
    pulseHistory?: string;
}> {
    const rec = await resolveAgentByENS(args);
    if (rec.agentId === undefined) throw new Error(`ENS name ${args.name} has no agentId text record`);
    if (!rec.address) throw new Error(`ENS name ${args.name} resolves to no address`);
    if (!rec.signerProvider) throw new Error(`ENS name ${args.name} has no signerProvider text record`);

    return {
        agentId: rec.agentId,
        address: rec.address,
        signerProvider: rec.signerProvider,
        pulseHistory: rec.pulseHistory
    };
}
