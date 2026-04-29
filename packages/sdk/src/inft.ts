/**
 * ERC-7857 iNFT primitives — composable building blocks for any agent
 * runtime that wants to mint, bind, transfer, or update an iNFT under
 * Pulse Protocol's PulseAgentINFT.
 *
 * Every function takes explicit viem clients + addresses + signers — no
 * env reads, no globals. A library consumer constructs their own clients
 * and passes them in. Same shape as pulse.ts and hook.ts in this SDK.
 */

import {
    type Address,
    type Hex,
    type LocalAccount,
    type PublicClient,
    type WalletClient,
    encodeAbiParameters,
    encodeFunctionData,
    keccak256,
    parseAbi,
    toHex
} from "viem";
import {randomBytes, createCipheriv, createDecipheriv} from "node:crypto";

import {INFT_ABI} from "./abi-inft.js";

export const ZG_GALILEO_CHAIN_ID = 16602;
export const ZG_GALILEO_RPC = "https://evmrpc-testnet.0g.ai";
export const ZG_STORAGE_INDEXER = "https://indexer-storage-testnet-turbo.0g.ai";

export const DEFAULT_MINT_GAS = 600_000n;
export const DEFAULT_BIND_GAS = 200_000n;
export const DEFAULT_RECORD_GAS = 150_000n;

// ─── encrypted state blob ──────────────────────────────────────────────────

export interface EncryptedBlob {
    /** AES-256-GCM key used to encrypt the plaintext (keep secret — anyone
     *  holding this can decrypt the iNFT state). */
    keyHex: Hex;
    /** 12-byte initialization vector. */
    ivHex: Hex;
    /** Ciphertext concatenated with the 16-byte GCM auth tag at the tail. */
    ciphertextHex: Hex;
    /** keccak256 of the ciphertext — what gets anchored on chain via mint. */
    dataHash: Hex;
}

/**
 * Encrypt an arbitrary plaintext (typically a JSON-stringified agent state
 * blob) and return both the sealed key + the on-chain dataHash. The hash is
 * what `mint(...)` anchors; the key is what the iNFT owner needs to decrypt
 * the blob from 0G Storage later.
 */
export function encryptStateBlob(plaintext: string): EncryptedBlob {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ciphertext = Buffer.concat([enc, tag]);
    const dataHash = keccak256(toHex(ciphertext));
    return {
        keyHex: `0x${key.toString("hex")}`,
        ivHex: `0x${iv.toString("hex")}`,
        ciphertextHex: `0x${ciphertext.toString("hex")}`,
        dataHash
    };
}

/**
 * Decrypt a blob given the key + IV + ciphertext (with auth tag at tail).
 * Useful for the iNFT owner reconstructing state after a transfer.
 */
export function decryptStateBlob(blob: {
    keyHex: Hex;
    ivHex: Hex;
    ciphertextHex: Hex;
}): string {
    const key = Buffer.from(blob.keyHex.slice(2), "hex");
    const iv = Buffer.from(blob.ivHex.slice(2), "hex");
    const full = Buffer.from(blob.ciphertextHex.slice(2), "hex");
    const tag = full.subarray(full.length - 16);
    const ciphertext = full.subarray(0, full.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
}

// ─── proof construction ───────────────────────────────────────────────────

/**
 * Build the ECDSA preimage proof PulseAgentINFT.mint expects.
 * The contract recovers `keccak256(abi.encode(inft, "preimage", dataHash))`
 * via `OZ ECDSA.toEthSignedMessageHash`, so we sign the same digest with
 * `signMessage` (auto-prepends the prefix).
 *
 * Returns the abi-encoded `(bytes32 dataHash, bytes signature)` blob ready
 * to drop into `proofs[i]`.
 */
export async function buildMintProof(
    signer: LocalAccount,
    inftAddress: Address,
    dataHash: Hex
): Promise<Hex> {
    const digest = keccak256(
        encodeAbiParameters(
            [{type: "address"}, {type: "string"}, {type: "bytes32"}],
            [inftAddress, "preimage", dataHash]
        )
    );
    const signature = await signer.signMessage({message: {raw: digest}});
    return encodeAbiParameters([{type: "bytes32"}, {type: "bytes"}], [dataHash, signature]);
}

/**
 * Build the ECDSA transfer-validity proof PulseAgentINFT.transfer / clone
 * expects. Returns the abi-encoded `(oldDataHash, newDataHash, receiver,
 * sealedKey, signature)` blob.
 */
export async function buildTransferProof(
    signer: LocalAccount,
    inftAddress: Address,
    args: {oldDataHash: Hex; newDataHash: Hex; receiver: Address; sealedKey: Hex}
): Promise<Hex> {
    const digest = keccak256(
        encodeAbiParameters(
            [
                {type: "address"},
                {type: "string"},
                {type: "bytes32"},
                {type: "bytes32"},
                {type: "address"},
                {type: "bytes16"}
            ],
            [
                inftAddress,
                "transfer",
                args.oldDataHash,
                args.newDataHash,
                args.receiver,
                args.sealedKey
            ]
        )
    );
    const signature = await signer.signMessage({message: {raw: digest}});
    return encodeAbiParameters(
        [
            {type: "bytes32"},
            {type: "bytes32"},
            {type: "address"},
            {type: "bytes16"},
            {type: "bytes"}
        ],
        [args.oldDataHash, args.newDataHash, args.receiver, args.sealedKey, signature]
    );
}

// ─── core write functions ──────────────────────────────────────────────────

export interface MintArgs {
    inftAddress: Address;
    proofs: Hex[];
    dataDescriptions: string[];
    to: Address;
}

/** Submit `mint(proofs, descriptions, to)` and return the tx hash. */
export async function mintINFT(
    wallet: WalletClient,
    args: MintArgs,
    opts: {gas?: bigint} = {}
): Promise<Hex> {
    const data = encodeFunctionData({
        abi: INFT_ABI,
        functionName: "mint",
        args: [args.proofs, args.dataDescriptions, args.to]
    });
    const account = wallet.account;
    if (!account) throw new Error("wallet missing account");
    return wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: args.inftAddress,
        data,
        gas: opts.gas ?? DEFAULT_MINT_GAS
    });
}

export interface BindArgs {
    inftAddress: Address;
    tokenId: bigint;
    agentId: bigint;
    ensNode: Hex;
    pulse: Address;
    pulseChainId: bigint;
}

/** Bind an iNFT to a Pulse identity stack (ENS, ERC-8004, Pulse contract). */
export async function bindPulseAgent(
    wallet: WalletClient,
    args: BindArgs,
    opts: {gas?: bigint} = {}
): Promise<Hex> {
    const data = encodeFunctionData({
        abi: INFT_ABI,
        functionName: "bindPulseAgent",
        args: [args.tokenId, args.agentId, args.ensNode, args.pulse, args.pulseChainId]
    });
    const account = wallet.account;
    if (!account) throw new Error("wallet missing account");
    return wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: args.inftAddress,
        data,
        gas: opts.gas ?? DEFAULT_BIND_GAS
    });
}

export interface RecordArgs {
    inftAddress: Address;
    tokenId: bigint;
    commitmentId: bigint;
    pulseChainId: bigint;
}

/** Append a Pulse commitment id to the iNFT's on-chain history. */
export async function recordCommitment(
    wallet: WalletClient,
    args: RecordArgs,
    opts: {gas?: bigint} = {}
): Promise<Hex> {
    const data = encodeFunctionData({
        abi: INFT_ABI,
        functionName: "recordCommitment",
        args: [args.tokenId, args.commitmentId, args.pulseChainId]
    });
    const account = wallet.account;
    if (!account) throw new Error("wallet missing account");
    return wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: args.inftAddress,
        data,
        gas: opts.gas ?? DEFAULT_RECORD_GAS
    });
}

// ─── reads ─────────────────────────────────────────────────────────────────

export interface INFTState {
    tokenId: bigint;
    owner: Address;
    dataHashes: readonly Hex[];
    dataDescriptions: readonly string[];
    tokenURI: string;
    pulseBinding: {
        agentId: bigint;
        ensNode: Hex;
        pulse: Address;
        pulseChainId: bigint;
    };
    commitments: readonly {commitmentId: bigint; pulseChainId: bigint; recordedAt: bigint}[];
    signerProvider: Address;
}

export async function readINFTState(
    publicClient: PublicClient,
    inftAddress: Address,
    tokenId: bigint
): Promise<INFTState> {
    const [owner, dataHashes, dataDescriptions, tokenURI, binding, commitments, signerProvider] =
        await Promise.all([
            publicClient.readContract({
                address: inftAddress,
                abi: INFT_ABI,
                functionName: "ownerOf",
                args: [tokenId]
            }) as Promise<Address>,
            publicClient.readContract({
                address: inftAddress,
                abi: INFT_ABI,
                functionName: "dataHashesOf",
                args: [tokenId]
            }) as Promise<readonly Hex[]>,
            publicClient.readContract({
                address: inftAddress,
                abi: INFT_ABI,
                functionName: "dataDescriptionsOf",
                args: [tokenId]
            }) as Promise<readonly string[]>,
            publicClient.readContract({
                address: inftAddress,
                abi: INFT_ABI,
                functionName: "tokenURI",
                args: [tokenId]
            }) as Promise<string>,
            publicClient.readContract({
                address: inftAddress,
                abi: INFT_ABI,
                functionName: "pulseBinding",
                args: [tokenId]
            }) as Promise<readonly [bigint, Hex, Address, bigint]>,
            publicClient.readContract({
                address: inftAddress,
                abi: INFT_ABI,
                functionName: "commitmentsOf",
                args: [tokenId]
            }) as Promise<
                readonly {commitmentId: bigint; pulseChainId: bigint; recordedAt: bigint}[]
            >,
            publicClient.readContract({
                address: inftAddress,
                abi: INFT_ABI,
                functionName: "signerProvider"
            }) as Promise<Address>
        ]);

    return {
        tokenId,
        owner,
        dataHashes,
        dataDescriptions,
        tokenURI,
        pulseBinding: {
            agentId: binding[0],
            ensNode: binding[1],
            pulse: binding[2],
            pulseChainId: binding[3]
        },
        commitments,
        signerProvider
    };
}

/**
 * Find the minted tokenId in a tx receipt's logs by decoding the
 * `Minted(uint256 indexed tokenId, ...)` event from PulseAgentINFT.
 */
export function extractMintedTokenId(
    inftAddress: Address,
    logs: readonly {address: Address; topics: readonly Hex[]}[]
): bigint | null {
    const MINTED_TOPIC = keccak256(toHex("Minted(uint256,address,address,bytes32[],string[])"));
    for (const log of logs) {
        if (log.address.toLowerCase() !== inftAddress.toLowerCase()) continue;
        if (log.topics[0] !== MINTED_TOPIC) continue;
        const idTopic = log.topics[1];
        if (!idTopic) continue;
        return BigInt(idTopic);
    }
    return null;
}

// Convenience re-export so consumers don't need to also import abi-inft.
export {INFT_ABI};

// Re-export the lower-level encoder used by parseAbi for downstream
// integrations that build their own custom calldata.
export const INFT_HUMAN_READABLE_ABI = parseAbi([
    "function mint(bytes[] proofs, string[] descriptions, address to) payable returns (uint256 tokenId)",
    "function bindPulseAgent(uint256 tokenId, uint256 agentId, bytes32 ensNode, address pulse, uint256 pulseChainId)",
    "function recordCommitment(uint256 tokenId, uint256 commitmentId, uint256 pulseChainId)",
    "function ownerOf(uint256 tokenId) view returns (address)",
    "function dataHashesOf(uint256 tokenId) view returns (bytes32[])",
    "function tokenURI(uint256 tokenId) view returns (string)",
    "function commitmentsOf(uint256 tokenId) view returns ((uint256 commitmentId, uint256 pulseChainId, uint64 recordedAt)[])",
    "function signerProvider() view returns (address)",
    "function totalSupply() view returns (uint256)"
]);
