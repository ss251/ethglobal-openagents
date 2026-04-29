#!/usr/bin/env bun
/**
 * ens-set-contenthash — set the ENSIP-7 contenthash record on a Pulse-bound
 * ENS name so the gate frontend resolves at <name>.eth.limo (and any other
 * eth-aware gateway like eth.link, brave://ens/, MetaMask, Status, etc.).
 *
 * Hosting flow:
 *   1. Pin apps/gate to a local kubo node:    `ipfs add -r apps/gate`
 *   2. Run this with --cid <CIDv1>:           Sepolia setContenthash tx
 *   3. Verify at https://<name>.eth.limo      eth.limo gateway proxies IPFS
 *
 * The script encodes the CID with @ensdomains/content-hash to produce the
 * canonical ENSIP-7 byte string (protocol prefix 0xe301 for IPFS + binary
 * CID), then writes it via the Public Resolver's setContenthash method.
 *
 * Usage:
 *   bun run scripts/ens-set-contenthash.ts --cid bafybeic... --execute
 *   bun run scripts/ens-set-contenthash.ts --cid bafybeic...   # dry-run
 *
 *   --name pulseagent.eth   override AGENT_ENS_NAME / default
 *   --resolver 0x...        override Sepolia Public Resolver (rare)
 */

import {encode as encodeContentHash} from "@ensdomains/content-hash";
import {
    createPublicClient,
    createWalletClient,
    http,
    namehash,
    parseAbi,
    type Address,
    type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";

import {loadEnv, requireEnv} from "./_lib/env.js";
import {step, runMain} from "./_lib/output.js";

loadEnv();

function flag(n: string): boolean {
    return process.argv.includes(`--${n}`);
}
function arg(n: string): string | null {
    const i = process.argv.indexOf(`--${n}`);
    if (i === -1 || i === process.argv.length - 1) return null;
    return process.argv[i + 1];
}

const RPC = requireEnv("SEPOLIA_RPC_URL");
const AGENT_KEY = requireEnv("AGENT_PRIVATE_KEY") as Hex;
const ENS_NAME = arg("name") || process.env.AGENT_ENS_NAME || "pulseagent.eth";
const CID = arg("cid");
const RESOLVER_OVERRIDE = arg("resolver") as Address | null;
const execute = flag("execute");

if (!CID) {
    console.error("✗ Missing --cid <CIDv1>. Pin first via `ipfs add -r apps/gate`.");
    process.exit(1);
}

const ENS_REGISTRY: Address = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

const account = privateKeyToAccount(AGENT_KEY);
const publicClient = createPublicClient({chain: sepolia, transport: http(RPC)});
const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(RPC),
});

const REGISTRY_ABI = parseAbi(["function resolver(bytes32 node) view returns (address)"]);
const RESOLVER_ABI = parseAbi([
    "function contenthash(bytes32 node) view returns (bytes)",
    "function setContenthash(bytes32 node, bytes hash)",
]);

async function main() {
    step(`══ ens-set-contenthash ══`);
    step(`  name        ${ENS_NAME}`);
    step(`  cid         ${CID}`);
    step(`  signer      ${account.address}`);
    step(`  mode        ${execute ? "EXECUTE (writes on chain)" : "DRY-RUN"}`);
    step("");

    // Encode the IPFS CID into ENSIP-7 contenthash bytes.
    // @ensdomains/content-hash exposes `encode(codec, value)` returning the
    // hex string (without 0x). Codec for IPFS is "ipfs-ns" / "ipfs".
    const encoded = "0x" + encodeContentHash("ipfs", CID);
    step(`  ENSIP-7 hex ${encoded}`);

    const node = namehash(ENS_NAME);
    const resolver: Address = RESOLVER_OVERRIDE ?? (await publicClient.readContract({
        address: ENS_REGISTRY,
        abi: REGISTRY_ABI,
        functionName: "resolver",
        args: [node],
    }));
    step(`  resolver    ${resolver}`);

    const before = await publicClient.readContract({
        address: resolver,
        abi: RESOLVER_ABI,
        functionName: "contenthash",
        args: [node],
    });
    step(`  current     ${before === "0x" ? "(unset)" : before}`);
    step("");

    if (!execute) {
        return {
            scenario: "ens-set-contenthash",
            mode: "dry-run",
            name: ENS_NAME,
            cid: CID,
            encoded,
            resolver,
            current: before,
            hint: "Re-run with --execute to write the contenthash on chain.",
        };
    }

    step(`▸ writing contenthash…`);
    const txHash = await walletClient.writeContract({
        address: resolver,
        abi: RESOLVER_ABI,
        functionName: "setContenthash",
        args: [node, encoded as Hex],
    });
    step(`  setContenthash tx → ${txHash}`);

    const receipt = await publicClient.waitForTransactionReceipt({hash: txHash});
    step(`  mined in block ${receipt.blockNumber.toString()} (status: ${receipt.status})`);

    const after = await publicClient.readContract({
        address: resolver,
        abi: RESOLVER_ABI,
        functionName: "contenthash",
        args: [node],
    });
    step(`  resolver returns: ${after}`);

    return {
        scenario: "ens-set-contenthash",
        mode: "execute",
        name: ENS_NAME,
        cid: CID,
        encoded,
        resolver,
        setContenthashTx: txHash,
        block: receipt.blockNumber.toString(),
        receiptStatus: receipt.status,
        after,
        gateway: `https://${ENS_NAME}.limo/`,
    };
}

runMain("ens-set-contenthash", main);
