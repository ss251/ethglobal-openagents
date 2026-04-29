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
    namehash,
    parseAbi
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";

import {loadEnv, requireEnv} from "./_lib/env";
import {zgGalileo, ZG_STORAGE_INDEXER, ZG_FAUCET} from "./_lib/zg";
import {step, runMain} from "./_lib/output";

// Full iNFT primitives ship in the SDK so any external integrator can do
// the same flow with a fraction of this code. The orchestrator below is
// just the CLI shape — encrypt + proof + mint + bind + record + ENS-text
// all live in @pulse/sdk.
import {
    encryptStateBlob,
    buildMintProof,
    mintINFT,
    bindPulseAgent as sdkBindPulseAgent,
    recordCommitment as sdkRecordCommitment,
    readINFTState,
    INFT_ABI as SDK_INFT_ABI
} from "../packages/sdk/src/inft";

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

const INFT_ABI = SDK_INFT_ABI;

const ENS_RESOLVER_ABI = parseAbi([
    "function setText(bytes32 node, string key, string value)",
    "function text(bytes32 node, string key) view returns (string)"
]);

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

    // ── 1. encrypt the agent state blob (SDK primitive) ───────────────────
    step("\n→ encrypt state blob (AES-256-GCM via @pulse/sdk)");
    const blob = encryptStateBlob(blobPlaintext);
    step(`  dataHash  : ${blob.dataHash}`);
    step(`  ciphertext: ${blob.ciphertextHex.length / 2 - 1} bytes (sealed key kept off-chain)`);

    // ── 2. (best-effort) upload to 0G Storage indexer ─────────────────────
    const storageUri = await uploadToZGStorage(blob.ciphertextHex);
    step(`  storageURI: ${storageUri}`);

    // ── 3. build TEE preimage proof (SDK primitive) ────────────────────────
    const proof = await buildMintProof(tee, INFT_ADDRESS, blob.dataHash);

    // ── 4. mint (SDK primitive) ────────────────────────────────────────────
    step("\n→ mint PulseAgentINFT");
    const mintTx = await mintINFT(zgWallet, {
        inftAddress: INFT_ADDRESS,
        proofs: [proof],
        dataDescriptions: [description],
        to: agent.address
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

    // ── 5. bindPulseAgent (SDK primitive) ──────────────────────────────────
    step("\n→ bindPulseAgent");
    const ensNode = namehash(ENS_NAME);
    const bindTx = await sdkBindPulseAgent(zgWallet, {
        inftAddress: INFT_ADDRESS,
        tokenId,
        agentId: AGENT_ID,
        ensNode,
        pulse: PULSE_ADDRESS,
        pulseChainId: 11155111n
    });
    await waitReceiptResilient(bindTx);
    step(`  bind tx   : ${bindTx}`);

    // ── 6. recordCommitment for each provided id (SDK primitive) ───────────
    const commitTxs: Hex[] = [];
    if (commitmentsCsv) {
        const ids = commitmentsCsv
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);
        step(`\n→ recordCommitment (${ids.length} commitments)`);
        for (const idStr of ids) {
            const id = BigInt(idStr);
            const tx = await sdkRecordCommitment(zgWallet, {
                inftAddress: INFT_ADDRESS,
                tokenId,
                commitmentId: id,
                pulseChainId: 11155111n
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

    // ── 8. read back for the JSON output (SDK primitive) ──────────────────
    const state = await readINFTState(zgClient, INFT_ADDRESS, tokenId);

    return {
        scenario: "inft-bind",
        status: "Success",
        zg: {
            chainId: zgGalileo.id,
            inft: INFT_ADDRESS,
            tokenId: tokenId.toString(),
            owner: state.owner,
            tokenURI: state.tokenURI,
            dataHashes: state.dataHashes,
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
