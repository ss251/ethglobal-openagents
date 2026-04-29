/**
 * ENSIP-25 — AI Agent Registry ENS Name Verification.
 *
 * The standard text-record format for binding an ENS name to a specific
 * on-chain agent registry entry (e.g. ERC-8004). Spec authors:
 *   premm.eth, raffy.eth, workemon.eth, ses.eth (draft, October 2025).
 *
 * Spec: https://docs.ens.domains/ensip/25
 *
 * Record key (parameterized text record):
 *   agent-registration[<registry>][<agentId>]
 *
 *   <registry> = ERC-7930 interoperable address (chainId-encoded) of the
 *                agent registry contract, hex with 0x prefix.
 *   <agentId>  = registry-defined agent identifier (string), MUST NOT
 *                contain `[` or `]`.
 *
 * Record value:
 *   any non-empty string. Implementations SHOULD set "1". Verification
 *   clients MUST treat any non-empty value as a positive attestation.
 *
 * This module provides:
 *   - encodeERC7930Address() — canonical (chainId, address) → ERC-7930 hex
 *   - decodeERC7930Address() — inverse, for validating + reading
 *   - ensip25TextRecordKey() — builds the parameterized key
 *   - readENSIP25() — looks up the verification text on a name + (registry, agentId)
 *   - writeENSIP25() — sets the canonical record on a name (Public Resolver)
 *   - ENSIP25_PULSE — preset for the deployed Pulse stack (Eth Sepolia 8004)
 *
 * The Pulse SDK's `pulseProvenanceFromENS` calls `readENSIP25` under the hood
 * so any consumer that resolves a Pulse agent through ENS gets ENSIP-25
 * verification "for free."
 */

import {
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient,
    namehash,
    isAddress,
    getAddress,
} from "viem";

// ─── ERC-7930 interoperable address ──────────────────────────────────────────
// Layout (per the example in ENSIP-25):
//   version(2) | chainNamespace(2) | chainRefLen(1) | chainRef(N) | addrLen(1) | addr(M)
// For EIP-155 EVM chains, chainNamespace = 0x0000.
// chainRef is the EIP-155 chainId encoded big-endian, with leading zero bytes
// stripped to the minimum length needed.

const VERSION = 0x0001;
const NS_EIP155 = 0x0000;

function chainIdToBytes(chainId: bigint | number): Uint8Array {
    let n = BigInt(chainId);
    if (n <= 0n) {
        throw new Error(`ERC-7930: chainId must be > 0, got ${chainId}`);
    }
    const bytes: number[] = [];
    while (n > 0n) {
        bytes.unshift(Number(n & 0xffn));
        n >>= 8n;
    }
    return Uint8Array.from(bytes);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    return n;
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Encode an EIP-155 (chainId, address) pair as an ERC-7930 interoperable
 * address. Returns lowercase hex with 0x prefix.
 *
 * Example: encodeERC7930Address(1, "0x8004A169...432")
 *       → "0x000100000101148004a169...432"
 */
export function encodeERC7930Address(
    chainId: bigint | number,
    address: Address,
): Hex {
    if (!isAddress(address)) {
        throw new Error(`ERC-7930: invalid address ${address}`);
    }
    const chainBytes = chainIdToBytes(chainId);
    if (chainBytes.length === 0 || chainBytes.length > 32) {
        throw new Error(`ERC-7930: chainId encoding length out of range`);
    }
    const addrHex = address.toLowerCase().replace(/^0x/, "");
    if (addrHex.length !== 40) {
        throw new Error(`ERC-7930: address must be 20 bytes`);
    }

    // version + namespace as 2 bytes each, big-endian
    const head = new Uint8Array(4);
    head[0] = (VERSION >> 8) & 0xff;
    head[1] = VERSION & 0xff;
    head[2] = (NS_EIP155 >> 8) & 0xff;
    head[3] = NS_EIP155 & 0xff;

    const out = `0x${hex(head)}${chainBytes.length.toString(16).padStart(2, "0")}${hex(chainBytes)}14${addrHex}`;
    return out as Hex;
}

export interface DecodedERC7930 {
    version: number;
    chainNamespace: number;
    chainId: bigint;
    address: Address;
}

/** Decode an ERC-7930 interoperable address back to (chainId, address). */
export function decodeERC7930Address(encoded: Hex): DecodedERC7930 {
    const raw = encoded.toLowerCase().replace(/^0x/, "");
    if (raw.length < 12) {
        throw new Error(`ERC-7930: payload too short`);
    }
    const buf = new Uint8Array(raw.length / 2);
    for (let i = 0; i < buf.length; i++) {
        buf[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
    }
    const version = (buf[0] << 8) | buf[1];
    const chainNamespace = (buf[2] << 8) | buf[3];
    const chainRefLen = buf[4];
    const chainRef = buf.slice(5, 5 + chainRefLen);
    const chainId = bytesToBigInt(chainRef);
    const addrLen = buf[5 + chainRefLen];
    if (addrLen !== 20) {
        throw new Error(`ERC-7930: expected 20-byte address, got ${addrLen}`);
    }
    const addrStart = 6 + chainRefLen;
    const addrBytes = buf.slice(addrStart, addrStart + 20);
    const addrHex = ("0x" + hex(addrBytes)) as Address;
    return {
        version,
        chainNamespace,
        chainId,
        address: getAddress(addrHex),
    };
}

// ─── ENSIP-25 text record key ────────────────────────────────────────────────

/**
 * Build the canonical ENSIP-25 parameterized text record key for a given
 * (registry, agentId) pair. The registry is encoded with ERC-7930 first.
 */
export function ensip25TextRecordKey(args: {
    registryChainId: bigint | number;
    registryAddress: Address;
    agentId: string | bigint | number;
}): string {
    const id = String(args.agentId);
    if (id.includes("[") || id.includes("]")) {
        throw new Error(`ENSIP-25: agentId may not contain '[' or ']'`);
    }
    const encoded = encodeERC7930Address(args.registryChainId, args.registryAddress);
    return `agent-registration[${encoded}][${id}]`;
}

// ─── Read / write helpers (consume the Pulse SDK's existing client patterns) ─

const ENS_PUBLIC_RESOLVER_ABI = [
    {
        type: "function",
        stateMutability: "view",
        name: "text",
        inputs: [
            {name: "node", type: "bytes32"},
            {name: "key", type: "string"},
        ],
        outputs: [{name: "", type: "string"}],
    },
    {
        type: "function",
        stateMutability: "nonpayable",
        name: "setText",
        inputs: [
            {name: "node", type: "bytes32"},
            {name: "key", type: "string"},
            {name: "value", type: "string"},
        ],
        outputs: [],
    },
] as const;

const ENS_REGISTRY_ABI = [
    {
        type: "function",
        stateMutability: "view",
        name: "resolver",
        inputs: [{name: "node", type: "bytes32"}],
        outputs: [{name: "", type: "address"}],
    },
] as const;

/** Default mainnet ENS registry — same address on all chains ENS supports. */
export const ENS_REGISTRY_ADDRESS: Address =
    "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

/**
 * Look up the resolver for a name on an ENS registry, then read the ENSIP-25
 * text record. Returns the raw value string ("" if not set).
 */
export async function readENSIP25(args: {
    publicClient: PublicClient;
    name: string;
    registryChainId: bigint | number;
    registryAddress: Address;
    agentId: string | bigint | number;
    ensRegistry?: Address;
}): Promise<{key: string; value: string; verified: boolean}> {
    const key = ensip25TextRecordKey({
        registryChainId: args.registryChainId,
        registryAddress: args.registryAddress,
        agentId: args.agentId,
    });
    const node = namehash(args.name);
    const resolver = (await args.publicClient.readContract({
        address: args.ensRegistry ?? ENS_REGISTRY_ADDRESS,
        abi: ENS_REGISTRY_ABI,
        functionName: "resolver",
        args: [node],
    })) as Address;
    if (!resolver || resolver === "0x0000000000000000000000000000000000000000") {
        return {key, value: "", verified: false};
    }
    const value = (await args.publicClient.readContract({
        address: resolver,
        abi: ENS_PUBLIC_RESOLVER_ABI,
        functionName: "text",
        args: [node, key],
    })) as string;
    return {key, value, verified: value.length > 0};
}

/**
 * Write the canonical ENSIP-25 record on a name. The wallet client must be
 * the owner of the name (or otherwise authorized on its resolver).
 *
 * Default value is `"1"` per the spec recommendation.
 */
export async function writeENSIP25(args: {
    publicClient: PublicClient;
    walletClient: WalletClient;
    name: string;
    registryChainId: bigint | number;
    registryAddress: Address;
    agentId: string | bigint | number;
    value?: string;
    ensRegistry?: Address;
}): Promise<{txHash: Hex; key: string; value: string}> {
    const key = ensip25TextRecordKey({
        registryChainId: args.registryChainId,
        registryAddress: args.registryAddress,
        agentId: args.agentId,
    });
    const value = args.value ?? "1";
    if (value.length === 0) {
        throw new Error(`ENSIP-25: value MUST be non-empty`);
    }
    const node = namehash(args.name);
    const resolver = (await args.publicClient.readContract({
        address: args.ensRegistry ?? ENS_REGISTRY_ADDRESS,
        abi: ENS_REGISTRY_ABI,
        functionName: "resolver",
        args: [node],
    })) as Address;
    if (!resolver || resolver === "0x0000000000000000000000000000000000000000") {
        throw new Error(`ENSIP-25: no resolver configured for ${args.name}`);
    }
    const account = args.walletClient.account;
    if (!account) throw new Error(`ENSIP-25: walletClient has no account`);
    const txHash = await args.walletClient.writeContract({
        account,
        chain: args.walletClient.chain,
        address: resolver,
        abi: ENS_PUBLIC_RESOLVER_ABI,
        functionName: "setText",
        args: [node, key, value],
    });
    return {txHash, key, value};
}

// ─── Pulse preset ─────────────────────────────────────────────────────────────

/**
 * Canonical ENSIP-25 binding parameters for the deployed Pulse stack.
 * Use as a one-liner: `readENSIP25({...client, name, ...ENSIP25_PULSE})`.
 */
export const ENSIP25_PULSE = {
    /** Eth Sepolia (chainId 11155111) — the chain Pulse + ERC-8004 are deployed on. */
    registryChainId: 11155111n,
    /** Canonical ERC-8004 IdentityRegistry address. */
    registryAddress:
        "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
} as const;
