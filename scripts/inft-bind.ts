#!/usr/bin/env bun
/**
 * inft-bind — mint pulseagent.eth as an ERC-7857 iNFT on 0G Galileo testnet,
 * bind it back to the agent's Pulse identity (ENS + ERC-8004 + Pulse contract),
 * and record the agent's recent Pulse commitments on the iNFT's on-chain history.
 *
 * Three things land:
 *   1. Encrypted state blob hash anchored on 0G via PulseAgentINFT.mint.
 *   2. PulseBinding entry on-chain → links iNFT tokenId to (agentId, ENS,
 *      Pulse contract, chainId).
 *   3. Recent Pulse commitments inserted into the iNFT's history. The new
 *      owner of this iNFT (transfer or clone) inherits this rep trail.
 *
 * Optional:
 *   - Set the ENS text record `0g.inft` so existing pulseProvenanceFromENS()
 *     readers can discover the iNFT from the agent's ENS name.
 *
 * Required env (auto-loaded from .env):
 *   ZG_RPC_URL or default https://evmrpc-testnet.0g.ai
 *   AGENT_PRIVATE_KEY     — same wallet that owns pulseagent.eth on Sepolia
 *   INFT_ADDRESS          — deployed PulseAgentINFT on 0G
 *   PULSE_ADDRESS         — Pulse.sol on Sepolia
 *   AGENT_ID              — ERC-8004 token id (3906)
 *   AGENT_ENS_NAME        — pulseagent.eth (default)
 *   DEMO_TEE_SIGNER_KEY   — TEE signer private key (must match contract's signerProvider)
 *
 * Usage:
 *   bun run scripts/inft-bind.ts \
 *     --commitments 9,12,13,14,15,21,23,24,25 \
 *     [--description "pulse-agent-state-v1"] \
 *     [--set-ens-text]   # also write 0g.inft text record on Sepolia
 *     [--encrypted-blob "free-form text"]   # the plaintext we hash + commit
 *
 * Output: single JSON object on stdout with tokenId, dataHash, tx hashes,
 * explorer links.
 */

import {
    type Address,
    type Hex,
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    namehash,
    parseAbi,
    toHex
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";
import {randomBytes, createCipheriv} from "node:crypto";

import {loadEnv, requireEnv} from "./_lib/env";
import {zgGalileo, ZG_STORAGE_INDEXER, ZG_FAUCET} from "./_lib/zg";
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

function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

const ZG_RPC = process.env.ZG_RPC_URL || zgGalileo.rpcUrls.default.http[0];
const AGENT_KEY = requireEnv("AGENT_PRIVATE_KEY") as Hex;
const TEE_KEY = requireEnv("DEMO_TEE_SIGNER_KEY") as Hex;
const INFT_ADDRESS = requireEnv("INFT_ADDRESS") as Address;
const PULSE_ADDRESS = requireEnv("PULSE_ADDRESS") as Address;
const AGENT_ID = BigInt(requireEnv("AGENT_ID"));
const ENS_NAME = process.env.AGENT_ENS_NAME || "pulseagent.eth";
const SEPOLIA_RPC = requireEnv("SEPOLIA_RPC_URL");
const ENS_RESOLVER = process.env.ENS_PUBLIC_RESOLVER || "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5";

const description = parseArg("description", "pulse-agent-state-v1");
const blobPlaintext = parseArg(
    "encrypted-blob",
    JSON.stringify({
        v: 1,
        agent: {
            ens: ENS_NAME,
            agentId: AGENT_ID.toString(),
            wallet: privateKeyToAccount(AGENT_KEY).address,
            erc8004IdentityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
            pulseChainId: 11155111,
            pulse: PULSE_ADDRESS
        },
        signing: {
            kind: "ECDSA",
            providerLabel: "0G Compute · qwen-2.5-7b-instruct (TEE-attested proxy)"
        },
        notes: "Pulse v0.4 — sealed reasoning + commit-reveal history bound into transferable iNFT state."
    })
);

const commitmentsCsv = parseArg("commitments", "");
const setEnsText = flag("set-ens-text");

const agent = privateKeyToAccount(AGENT_KEY);
const tee = privateKeyToAccount(TEE_KEY);

const zgClient = createPublicClient({chain: zgGalileo, transport: http(ZG_RPC)});
const zgWallet = createWalletClient({account: agent, chain: zgGalileo, transport: http(ZG_RPC)});

const sepClient = createPublicClient({chain: sepolia, transport: http(SEPOLIA_RPC)});
const sepWallet = createWalletClient({account: agent, chain: sepolia, transport: http(SEPOLIA_RPC)});

const INFT_ABI = parseAbi([
    "function mint(bytes[] proofs, string[] descriptions, address to) payable returns (uint256 tokenId)",
    "function bindPulseAgent(uint256 tokenId, uint256 agentId, bytes32 ensNode, address pulse, uint256 pulseChainId)",
    "function recordCommitment(uint256 tokenId, uint256 commitmentId, uint256 pulseChainId)",
    "function ownerOf(uint256 tokenId) view returns (address)",
    "function dataHashesOf(uint256 tokenId) view returns (bytes32[])",
    "function dataDescriptionsOf(uint256 tokenId) view returns (string[])",
    "function tokenURI(uint256 tokenId) view returns (string)",
    "function commitmentsOf(uint256 tokenId) view returns ((uint256 commitmentId, uint256 pulseChainId, uint64 recordedAt)[])",
    "function signerProvider() view returns (address)",
    "function totalSupply() view returns (uint256)",
    "event Minted(uint256 indexed tokenId, address indexed creator, address indexed owner, bytes32[] dataHashes, string[] dataDescriptions)",
    "event PulseBound(uint256 indexed tokenId, uint256 indexed agentId, bytes32 ensNode, address pulse, uint256 pulseChainId)",
    "event CommitmentRecorded(uint256 indexed tokenId, uint256 indexed commitmentId, uint256 pulseChainId, uint256 totalCommitments)"
]);

const ENS_RESOLVER_ABI = parseAbi([
    "function setText(bytes32 node, string key, string value)",
    "function text(bytes32 node, string key) view returns (string)"
]);

interface EncryptedBlob {
    keyHex: Hex;
    ivHex: Hex;
    ciphertextHex: Hex;
    dataHash: Hex;
}

function encryptBlob(plaintext: string): EncryptedBlob {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ciphertext = Buffer.concat([encrypted, tag]); // include auth tag at the tail
    const dataHash = keccak256(toHex(ciphertext));
    return {
        keyHex: `0x${key.toString("hex")}`,
        ivHex: `0x${iv.toString("hex")}`,
        ciphertextHex: `0x${ciphertext.toString("hex")}`,
        dataHash
    };
}

async function uploadToZGStorage(_data: Hex): Promise<string> {
    // The 0G Storage indexer is HTTP-based. For the hackathon we capture
    // the URI and dataHash but skip the actual upload (the indexer requires
    // a CLI or SDK with a specific upload protocol). The contract anchors
    // the dataHash regardless — agents that want to fetch the plaintext
    // can use the upload helper later. We surface the helper invocation in
    // the JSON output so a follow-up run can complete the storage step.
    return `${ZG_STORAGE_INDEXER}/file?root=<run \`0g-storage-cli upload\` to publish>`;
}

async function waitReceiptResilient(hash: Hex, attempts = 8): Promise<"success" | "reverted" | "unknown"> {
    // 0G Galileo testnet RPC sometimes loses just-broadcast receipts for 5-10
    // seconds. waitForTransactionReceipt throws immediately. Poll with
    // exponential backoff so we don't fail an entire run on a single flake.
    for (let i = 0; i < attempts; i++) {
        try {
            const r = await zgClient.getTransactionReceipt({hash});
            return r.status;
        } catch {
            await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        }
    }
    return "unknown";
}

async function ensureFunded(): Promise<bigint> {
    const bal = await zgClient.getBalance({address: agent.address});
    if (bal === 0n) {
        throw new Error(
            `agent ${agent.address} has 0 OG on 0G Galileo. Claim from ${ZG_FAUCET} (chainId 16602) and retry.`
        );
    }
    return bal;
}

async function main() {
    step("══ inft-bind: mint Pulse iNFT on 0G Galileo ══");
    step(`  agent     : ${agent.address} (ens=${ENS_NAME}, id=${AGENT_ID})`);
    step(`  inft      : ${INFT_ADDRESS}`);
    step(`  zg rpc    : ${ZG_RPC}`);
    step(`  pulse     : ${PULSE_ADDRESS} (Eth Sepolia)`);

    const balance = await ensureFunded();
    step(`  OG balance: ${balance}`);

    // Sanity-check the contract's signer matches our TEE key.
    const onChainSigner = (await zgClient.readContract({
        address: INFT_ADDRESS,
        abi: INFT_ABI,
        functionName: "signerProvider"
    })) as Address;
    if (onChainSigner.toLowerCase() !== tee.address.toLowerCase()) {
        step(
            `  ⚠ on-chain signerProvider (${onChainSigner}) does not match DEMO_TEE_SIGNER (${tee.address}).`
        );
        step(`    The mint will revert. Re-deploy the iNFT with --signer ${tee.address}.`);
        throw new Error("signer mismatch");
    }

    // ── 1. encrypt the agent state blob ───────────────────────────────────
    step("\n→ encrypt state blob (AES-256-GCM)");
    const blob = encryptBlob(blobPlaintext);
    step(`  dataHash  : ${blob.dataHash}`);
    step(`  ciphertext: ${blob.ciphertextHex.length / 2 - 1} bytes (sealed key kept off-chain)`);

    // ── 2. (best-effort) upload to 0G Storage indexer ─────────────────────
    const storageUri = await uploadToZGStorage(blob.ciphertextHex);
    step(`  storageURI: ${storageUri}`);

    // ── 3. build TEE preimage proof ────────────────────────────────────────
    // Contract-side: keccak256(abi.encode(inft, "preimage", dataHash)) is
    // hashed, then ECDSA.toEthSignedMessageHash() is applied (inside OZ).
    // We sign over the inner digest with viem.signMessage, which auto-prepends
    // the EthSignedMessage prefix — so the contract recovers the same address.
    const {encodeAbiParameters} = await import("viem");
    const preimageDigest = keccak256(
        encodeAbiParameters(
            [{type: "address"}, {type: "string"}, {type: "bytes32"}],
            [INFT_ADDRESS, "preimage", blob.dataHash]
        )
    );
    const preimageSig = await tee.signMessage({message: {raw: preimageDigest}});
    const proof = encodeAbiParameters(
        [{type: "bytes32"}, {type: "bytes"}],
        [blob.dataHash, preimageSig]
    );

    // ── 4. mint ───────────────────────────────────────────────────────────
    step("\n→ mint PulseAgentINFT");
    const mintTx = await zgWallet.writeContract({
        address: INFT_ADDRESS,
        abi: INFT_ABI,
        functionName: "mint",
        args: [[proof], [description], agent.address],
        gas: 600_000n
    });
    const mintStatus = await waitReceiptResilient(mintTx);
    if (mintStatus === "reverted") {
        throw new Error(`mint reverted: ${mintTx}`);
    }
    if (mintStatus === "unknown") {
        step(`  ⚠ mint receipt not confirmed yet — continuing optimistically`);
    }
    // Pull tokenId from totalSupply (the just-minted token is the latest).
    const tokenId = (await zgClient.readContract({
        address: INFT_ADDRESS,
        abi: INFT_ABI,
        functionName: "totalSupply"
    })) as bigint;
    step(`  mint tx   : ${mintTx}`);
    step(`  tokenId   : ${tokenId}`);

    // ── 5. bindPulseAgent ─────────────────────────────────────────────────
    step("\n→ bindPulseAgent");
    const ensNode = namehash(ENS_NAME);
    const bindTx = await zgWallet.writeContract({
        address: INFT_ADDRESS,
        abi: INFT_ABI,
        functionName: "bindPulseAgent",
        args: [tokenId, AGENT_ID, ensNode, PULSE_ADDRESS, 11155111n],
        gas: 200_000n
    });
    await waitReceiptResilient(bindTx);
    step(`  bind tx   : ${bindTx}`);

    // ── 6. recordCommitment for each provided id ───────────────────────────
    const commitTxs: Hex[] = [];
    if (commitmentsCsv) {
        const ids = commitmentsCsv
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);
        step(`\n→ recordCommitment (${ids.length} commitments)`);
        for (const idStr of ids) {
            const id = BigInt(idStr);
            const tx = await zgWallet.writeContract({
                address: INFT_ADDRESS,
                abi: INFT_ABI,
                functionName: "recordCommitment",
                args: [tokenId, id, 11155111n],
                gas: 150_000n
            });
            const s = await waitReceiptResilient(tx);
            step(`  cid #${id} → ${tx} (${s})`);
            commitTxs.push(tx);
        }
    }

    // ── 7. (optional) ENS text record on Sepolia ──────────────────────────
    let ensTextTx: Hex | null = null;
    if (setEnsText) {
        step("\n→ setText 0g.inft on ENS PublicResolver (Sepolia)");
        const value = `0g-galileo:${zgGalileo.id}:${INFT_ADDRESS}:${tokenId}`;
        ensTextTx = await sepWallet.writeContract({
            address: ENS_RESOLVER as Address,
            abi: ENS_RESOLVER_ABI,
            functionName: "setText",
            args: [ensNode, "0g.inft", value]
        });
        await sepClient.waitForTransactionReceipt({hash: ensTextTx});
        step(`  ens tx    : ${ensTextTx}`);
        step(`  text 0g.inft = ${value}`);
    }

    // ── 8. read back for the JSON output ──────────────────────────────────
    const ownerOf = (await zgClient.readContract({
        address: INFT_ADDRESS,
        abi: INFT_ABI,
        functionName: "ownerOf",
        args: [tokenId]
    })) as Address;
    const dataHashes = (await zgClient.readContract({
        address: INFT_ADDRESS,
        abi: INFT_ABI,
        functionName: "dataHashesOf",
        args: [tokenId]
    })) as Hex[];
    const tokenUri = (await zgClient.readContract({
        address: INFT_ADDRESS,
        abi: INFT_ABI,
        functionName: "tokenURI",
        args: [tokenId]
    })) as string;

    return {
        scenario: "inft-bind",
        status: "Success",
        zg: {
            chainId: zgGalileo.id,
            inft: INFT_ADDRESS,
            tokenId: tokenId.toString(),
            owner: ownerOf,
            tokenURI: tokenUri,
            dataHashes,
            description,
            mintTx,
            bindTx,
            recordCommitmentTxs: commitTxs,
            explorer: {
                contract: `https://chainscan-galileo.0g.ai/address/${INFT_ADDRESS}`,
                mint: `https://chainscan-galileo.0g.ai/tx/${mintTx}`,
                bind: `https://chainscan-galileo.0g.ai/tx/${bindTx}`
            }
        },
        sepolia: {
            ensName: ENS_NAME,
            ensNode,
            agentId: AGENT_ID.toString(),
            pulse: PULSE_ADDRESS,
            ensTextTx,
            ensTextValue: setEnsText
                ? `0g-galileo:${zgGalileo.id}:${INFT_ADDRESS}:${tokenId}`
                : null,
            explorer: {
                ens: `https://sepolia.app.ens.domains/${ENS_NAME}`,
                ensText: ensTextTx ? `https://sepolia.etherscan.io/tx/${ensTextTx}` : null
            }
        },
        encryptedState: {
            dataHash: blob.dataHash,
            ciphertextBytes: blob.ciphertextHex.length / 2 - 1,
            keyHex: blob.keyHex, // keep this safe — anyone with it can decrypt the blob
            ivHex: blob.ivHex,
            storageURI: storageUri
        }
    };
}

runMain("inft-bind", main);
