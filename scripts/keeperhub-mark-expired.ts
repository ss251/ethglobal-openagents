#!/usr/bin/env bun
/**
 * keeperhub-mark-expired — sweep stuck-Pending Pulse commitments and call
 * Pulse.markExpired(id) on each, slashing the agent's reputation by -500.
 *
 * Drop-in replacement for an off-chain "expirer daemon." Designed to run
 * either:
 *   A. Locally (this script, callable by anyone — Pulse.markExpired is permissionless).
 *   B. As a KeeperHub workflow (cron 5min) — see keeperhub/workflows/pulse-mark-expired.json.
 *      The workflow's `contract-call` action invokes the same on-chain function;
 *      this script's value is the *iteration* over stuck commitments.
 *
 * Usage:
 *   bun run scripts/keeperhub-mark-expired.ts            # scan + dry-run report
 *   bun run scripts/keeperhub-mark-expired.ts --execute  # actually mark expired
 *   bun run scripts/keeperhub-mark-expired.ts --ids 21,25,26 --execute   # specific ids
 *
 * Required env: SEPOLIA_RPC_URL, PULSE_ADDRESS, AGENT_PRIVATE_KEY (or
 * KEEPER_PRIVATE_KEY — overrides the agent key for keeper-only setups).
 *
 * Output: single JSON object on stdout with the sweep summary. BigInt-safe.
 */

import {
    type Address,
    type Hex,
    createPublicClient,
    createWalletClient,
    encodeFunctionData,
    http,
    parseAbi
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";

import {loadEnv, requireEnv} from "./_lib/env";
import {readCommitment} from "./_lib/pulse";
import {step, runMain} from "./_lib/output";

loadEnv();

function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}
function arg(name: string): string | null {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx === -1 || idx === process.argv.length - 1) return null;
    return process.argv[idx + 1];
}

const RPC = requireEnv("SEPOLIA_RPC_URL");
const PULSE = requireEnv("PULSE_ADDRESS") as Address;
const KEEPER_KEY = (process.env.KEEPER_PRIVATE_KEY || requireEnv("AGENT_PRIVATE_KEY")) as Hex;
const execute = flag("execute");

const PULSE_ABI = parseAbi([
    "function markExpired(uint256 id)",
    "function getStatus(uint256 id) view returns (uint8)"
]);

const keeper = privateKeyToAccount(KEEPER_KEY);
const publicClient = createPublicClient({chain: sepolia, transport: http(RPC)});
const walletClient = createWalletClient({account: keeper, chain: sepolia, transport: http(RPC)});

interface Sweep {
    id: bigint;
    status: number;
    statusLabel: string;
    overdueExpired: boolean;
    exists: boolean;
    revealDeadline: bigint;
    markExpiredTx?: Hex;
    error?: string;
}

async function classifyIds(ids: bigint[]): Promise<Sweep[]> {
    const out: Sweep[] = [];
    for (const id of ids) {
        try {
            const c = await readCommitment(publicClient, PULSE, id);
            // A non-existent commitment returns the zero struct: commitTime=0,
            // status=Pending. _lib/pulse's overdueExpired flag fires on those
            // because 0 < now and status==Pending — exclude them here.
            const exists = c.commitTime > 0n;
            out.push({
                id,
                status: c.status,
                statusLabel: c.statusLabel,
                overdueExpired: exists && c.overdueExpired,
                exists,
                revealDeadline: c.revealDeadline
            });
        } catch (e: unknown) {
            const m = (e as Error).message;
            out.push({
                id,
                status: -1,
                statusLabel: "Unknown",
                overdueExpired: false,
                exists: false,
                revealDeadline: 0n,
                error: m.slice(0, 120)
            });
        }
    }
    return out;
}

async function main() {
    const explicit = arg("ids");
    const ids = explicit
        ? explicit.split(",").map(s => BigInt(s.trim())).filter(s => s > 0n)
        : Array.from({length: 30}, (_, i) => BigInt(i + 1)); // scan first 30 cids by default

    step(`══ keeperhub-mark-expired sweep ══`);
    step(`  pulse  : ${PULSE}`);
    step(`  keeper : ${keeper.address}`);
    step(`  scan   : cid ${ids[0]}–${ids[ids.length - 1]} (${ids.length} ids)`);
    step(`  mode   : ${execute ? "EXECUTE (mainnet write)" : "DRY-RUN"}`);

    const all = await classifyIds(ids);
    const expirable = all.filter(s => s.overdueExpired);

    step(`\n  found ${expirable.length} expirable commitments:`);
    for (const s of expirable) {
        step(`    cid #${s.id}  status=${s.statusLabel}  overdueExpired=true`);
    }

    if (!execute) {
        return {
            scenario: "keeperhub-mark-expired",
            mode: "dry-run",
            scannedCount: all.length,
            expirableCount: expirable.length,
            expirable: expirable.map(s => ({
                id: s.id.toString(),
                status: s.statusLabel,
                revealDeadline: s.revealDeadline.toString()
            })),
            hint: "Re-run with --execute to actually call Pulse.markExpired(id) on each."
        };
    }

    if (expirable.length === 0) {
        return {
            scenario: "keeperhub-mark-expired",
            mode: "execute",
            expiredCount: 0,
            note: "Nothing to expire. Sweep complete."
        };
    }

    step(`\n  executing markExpired across ${expirable.length} commitment(s)…`);
    const results: Sweep[] = [];
    for (const s of expirable) {
        try {
            const data = encodeFunctionData({
                abi: PULSE_ABI,
                functionName: "markExpired",
                args: [s.id]
            });
            const tx = await walletClient.sendTransaction({
                to: PULSE,
                data,
                gas: 500_000n // RPC underbudgets giveFeedback's storage writes — see ADR
            });
            await publicClient.waitForTransactionReceipt({hash: tx});
            step(`    cid #${s.id} → ${tx}`);
            results.push({...s, markExpiredTx: tx});
        } catch (e: unknown) {
            const m = (e as {shortMessage?: string; message?: string});
            const reason = m?.shortMessage || m?.message || String(e);
            step(`    cid #${s.id} → FAILED: ${reason.slice(0, 80)}`);
            results.push({...s, error: reason.slice(0, 200)});
        }
    }

    return {
        scenario: "keeperhub-mark-expired",
        mode: "execute",
        keeper: keeper.address,
        scannedCount: all.length,
        expirableCount: expirable.length,
        expiredCount: results.filter(r => r.markExpiredTx).length,
        failedCount: results.filter(r => r.error).length,
        results: results.map(r => ({
            id: r.id.toString(),
            statusBefore: r.statusLabel,
            revealDeadline: r.revealDeadline.toString(),
            markExpiredTx: r.markExpiredTx ?? null,
            error: r.error ?? null
        }))
    };
}

runMain("keeperhub-mark-expired", main);
