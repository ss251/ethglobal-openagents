#!/usr/bin/env bun
/**
 * pulse-introspect — show recent on-chain activity for the agent wallet.
 *
 * Replaces the ad-hoc block-scanning agents tend to write inline when a swap
 * fails (eth_getBlock loops over `includeTransactions` etc.). This is the
 * canonical introspection helper — the agent should always reach for this
 * before rolling its own.
 *
 * Output is a clean table (stdout) — agent narrates the rows back. Stderr
 * carries the scan progress.
 *
 * Usage:
 *   bun run scripts/pulse-introspect.ts                   # last 20 blocks
 *   bun run scripts/pulse-introspect.ts --last 50
 *   bun run scripts/pulse-introspect.ts --from-block 10756500
 *   bun run scripts/pulse-introspect.ts --commitment-id 11   # status for one
 *
 * Bigint-safe — never breaks on JSON.stringify with uint256s.
 */

import {
    type Address,
    type Hex,
    createPublicClient,
    decodeFunctionData,
    http
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";

import {loadEnv, requireEnv} from "./_lib/env";
import {PULSE_ABI, SWAP_ROUTER_ABI, ERC20_ABI} from "./_lib/abi";
import {readCommitment} from "./_lib/pulse";
import {step, runMain} from "./_lib/output";

loadEnv();

function parseArg(name: string): string | null {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx === -1 || idx === process.argv.length - 1) return null;
    return process.argv[idx + 1];
}

const RPC = requireEnv("SEPOLIA_RPC_URL");
const PULSE = requireEnv("PULSE_ADDRESS") as Address;
const SWAP_ROUTER = requireEnv("POOL_SWAP_TEST") as Address;
const TOKEN0 = requireEnv("POOL_TOKEN0") as Address;
const TOKEN1 = requireEnv("POOL_TOKEN1") as Address;
const AGENT_KEY = requireEnv("AGENT_PRIVATE_KEY") as Hex;
const agent = privateKeyToAccount(AGENT_KEY);

const publicClient = createPublicClient({chain: sepolia, transport: http(RPC)});

const ALL_ABIS = [...PULSE_ABI, ...SWAP_ROUTER_ABI, ...ERC20_ABI];

function decodeFnName(data: Hex): string {
    if (data.length < 10) return "—";
    try {
        const decoded = decodeFunctionData({abi: ALL_ABIS, data});
        return decoded.functionName;
    } catch {
        return data.slice(0, 10);
    }
}

function labelTo(to: Address | null | undefined): string {
    if (!to) return "(create)";
    const t = to.toLowerCase();
    if (t === PULSE.toLowerCase()) return "Pulse";
    if (t === SWAP_ROUTER.toLowerCase()) return "SwapTest";
    if (t === TOKEN0.toLowerCase()) return "TOKEN0";
    if (t === TOKEN1.toLowerCase()) return "TOKEN1";
    return to.slice(0, 10) + "…";
}

async function inspectCommitment(id: bigint) {
    const c = await readCommitment(publicClient, PULSE, id);
    return {
        scenario: "pulse-introspect",
        mode: "commitment",
        commitment: {
            id: c.id.toString(),
            status: c.statusLabel,
            statusCode: c.status,
            agentId: c.agentId.toString(),
            principal: c.principal,
            commitTime: c.commitTime.toString(),
            executeAfter: c.executeAfter.toString(),
            revealDeadline: c.revealDeadline.toString(),
            now: Math.floor(Date.now() / 1000),
            inRevealWindow: c.inRevealWindow,
            overdueExpired: c.overdueExpired,
            intentHash: c.intentHash,
            reasoningCID: c.reasoningCID,
            signerProvider: c.signerProvider
        }
    };
}

async function scanRecent(fromBlock: bigint | null, lastN: number) {
    const latest = await publicClient.getBlockNumber();
    const start = fromBlock ?? latest - BigInt(lastN);
    step(`scanning blocks ${start} → ${latest}  (target=${agent.address})`);

    const rows: Array<{
        block: string;
        tx: Hex;
        to: string;
        fn: string;
        status: "success" | "reverted";
        gas: string;
    }> = [];

    for (let bn = latest; bn >= start; bn--) {
        const block = await publicClient.getBlock({blockNumber: bn, includeTransactions: true});
        for (const tx of block.transactions) {
            if (typeof tx === "string") continue;
            if (tx.from?.toLowerCase() !== agent.address.toLowerCase()) continue;
            const receipt = await publicClient.getTransactionReceipt({hash: tx.hash});
            rows.push({
                block: bn.toString(),
                tx: tx.hash,
                to: labelTo(tx.to),
                fn: decodeFnName(tx.input as Hex),
                status: receipt.status,
                gas: receipt.gasUsed.toString()
            });
        }
    }

    return {
        scenario: "pulse-introspect",
        mode: "scan",
        agentWallet: agent.address,
        scannedFrom: start.toString(),
        scannedTo: latest.toString(),
        txCount: rows.length,
        transactions: rows
    };
}

async function main() {
    const cidArg = parseArg("commitment-id");
    if (cidArg) {
        return inspectCommitment(BigInt(cidArg));
    }
    const fromBlock = parseArg("from-block");
    const lastN = Number(parseArg("last") ?? "20");
    return scanRecent(fromBlock ? BigInt(fromBlock) : null, lastN);
}

runMain("pulse-introspect", main);
