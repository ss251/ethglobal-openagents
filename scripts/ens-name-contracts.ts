#!/usr/bin/env bun
/**
 * ens-name-contracts — give the deployed Pulse contracts ENS subnames under
 * `pulseagent.eth`, so block explorers, agent skill bundles, and any
 * ENS-aware client can refer to them by name instead of raw hex.
 *
 * Subnames created (overridable via --subname=<label>:<addr>):
 *   pulse.pulseagent.eth   → 0xbe1b…BF34   (Pulse.sol)
 *   hook.pulseagent.eth    → 0x274b…c080   (PulseGatedHook.sol)
 *   gate.pulseagent.eth    → 0x4d11…9379   (PulseGatedGate.sol — v0.7.0)
 *   inft.pulseagent.eth    → 0x180D…227C   (PulseAgentINFT.sol on 0G Galileo)
 *
 * Each subname is created via two transactions:
 *   1. ENSRegistry.setSubnodeRecord(parent, keccak(label), owner, resolver, 0)
 *      — creates the subname pointed at the Public Resolver, owned by the
 *        agent (so subsequent resolver ops are authorized).
 *   2. PublicResolver.setAddr(subnameNode, address)
 *      — sets the EVM address record for the subname.
 *
 * Per Greg Skril's "Identity for Apps, Agents & More with ENS" workshop:
 * "ENS can be used to name any address. And that includes EOAs, smart
 * accounts, and smart contracts of any sort. This is an underexplored
 * thing that we love to see people use at hackathons."
 *
 * Usage:
 *   bun run scripts/ens-name-contracts.ts                    # dry-run
 *   bun run scripts/ens-name-contracts.ts --execute          # writes
 *   bun run scripts/ens-name-contracts.ts --only gate --execute  # one only
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    namehash,
    parseAbi,
    stringToHex,
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
const PARENT_NAME = arg("parent") || process.env.AGENT_ENS_NAME || "pulseagent.eth";
const ONLY_LABEL = arg("only");
const execute = flag("execute");

const ENS_REGISTRY: Address = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const SEPOLIA_PUBLIC_RESOLVER: Address =
    "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5";

const account = privateKeyToAccount(AGENT_KEY);
const publicClient = createPublicClient({chain: sepolia, transport: http(RPC)});
const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(RPC),
});

const REGISTRY_ABI = parseAbi([
    "function owner(bytes32 node) view returns (address)",
    "function resolver(bytes32 node) view returns (address)",
    "function setSubnodeRecord(bytes32 node, bytes32 label, address owner, address resolver, uint64 ttl)",
]);

const RESOLVER_ABI = parseAbi([
    "function setAddr(bytes32 node, address addr)",
    "function addr(bytes32 node) view returns (address)",
    "function setText(bytes32 node, string key, string value)",
    "function text(bytes32 node, string key) view returns (string)",
]);

interface ContractEntry {
    label: string;
    address: Address;
    description: string;
}

// Default contract list. Pulse, Hook, Gate live on Eth Sepolia. INFT lives on
// 0G Galileo — naming it on Sepolia ENS still works (an ENS address record
// just stores 20 bytes; the chain context is implicit and documented).
const CONTRACTS: ContractEntry[] = [
    {
        label: "pulse",
        address: (process.env.PULSE_ADDRESS ||
            "0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34") as Address,
        description: "Pulse — sealed agent commitment primitive (Eth Sepolia)",
    },
    {
        label: "hook",
        address: (process.env.HOOK_ADDRESS ||
            "0x274b3c0f55c2db8c392418649c1eb3aad1ecc080") as Address,
        description: "PulseGatedHook — Uniswap v4 hook gating swaps on Pulse commitments",
    },
    {
        label: "gate",
        address: (process.env.GATE_ADDRESS ||
            "0x4d11e22268b8512B01dA7182a52Ba040A0709379") as Address,
        description: "PulseGatedGate — reference reputation-gate consumer (v0.7.0)",
    },
    {
        label: "inft",
        address: (process.env.INFT_ADDRESS ||
            "0x180D8105dc415553e338BDB06251e8aC3e48227C") as Address,
        description: "PulseAgentINFT — ERC-7857 agent NFT on 0G Galileo (chainId 16602)",
    },
];

async function main() {
    const parentNode = namehash(PARENT_NAME);
    const parentOwner = (await publicClient.readContract({
        address: ENS_REGISTRY,
        abi: REGISTRY_ABI,
        functionName: "owner",
        args: [parentNode],
    })) as Address;

    step(`══ ens-name-contracts ══`);
    step(`  parent       ${PARENT_NAME}`);
    step(`  parent owner ${parentOwner}`);
    step(`  signer       ${account.address}`);
    step(`  resolver     ${SEPOLIA_PUBLIC_RESOLVER}`);
    step(`  mode         ${execute ? "EXECUTE (writes on chain)" : "DRY-RUN"}`);
    step("");

    if (parentOwner.toLowerCase() !== account.address.toLowerCase()) {
        step(
            `  ⚠ signer is NOT the parent owner. Subname creation will revert. ` +
                `Make sure pulseagent.eth is owned by AGENT_PRIVATE_KEY's address.`,
        );
    }

    const targets = ONLY_LABEL
        ? CONTRACTS.filter((c) => c.label === ONLY_LABEL)
        : CONTRACTS;

    if (targets.length === 0) {
        return {scenario: "ens-name-contracts", error: `no contracts match --only=${ONLY_LABEL}`};
    }

    interface ResultRow {
        label: string;
        subname: string;
        address: Address;
        priorOwner?: Address;
        priorAddr?: Address | "" | null;
        subnodeTx?: Hex;
        setAddrTx?: Hex;
        setTextTx?: Hex;
        finalAddr?: Address;
        skipped?: string;
        error?: string;
    }
    const results: ResultRow[] = [];

    for (const c of targets) {
        const subname = `${c.label}.${PARENT_NAME}`;
        const subnode = namehash(subname);
        const labelHash = keccak256(stringToHex(c.label));

        step(`▸ ${c.label.padEnd(6)} → ${c.address}`);
        step(`    subname:    ${subname}`);

        const row: ResultRow = {label: c.label, subname, address: c.address};

        try {
            const priorOwner = (await publicClient.readContract({
                address: ENS_REGISTRY,
                abi: REGISTRY_ABI,
                functionName: "owner",
                args: [subnode],
            })) as Address;
            row.priorOwner = priorOwner;

            let priorAddr: Address | null = null;
            if (
                priorOwner !== "0x0000000000000000000000000000000000000000"
            ) {
                try {
                    priorAddr = (await publicClient.readContract({
                        address: SEPOLIA_PUBLIC_RESOLVER,
                        abi: RESOLVER_ABI,
                        functionName: "addr",
                        args: [subnode],
                    })) as Address;
                } catch {}
            }
            row.priorAddr = priorAddr ?? "";

            step(`    prior:      owner=${priorOwner} addr=${priorAddr || "(unset)"}`);

            if (
                priorAddr &&
                priorAddr.toLowerCase() === c.address.toLowerCase()
            ) {
                step(`    ✓ already correct, skipping`);
                row.skipped = "already-set";
                row.finalAddr = priorAddr;
                results.push(row);
                step("");
                continue;
            }

            if (!execute) {
                step(`    (dry-run: would create subnode + setAddr + setText)`);
                results.push(row);
                step("");
                continue;
            }

            // Step 1: create / refresh the subnode under our control with the public resolver.
            step(`    setSubnodeRecord…`);
            const subnodeTx = await walletClient.writeContract({
                address: ENS_REGISTRY,
                abi: REGISTRY_ABI,
                functionName: "setSubnodeRecord",
                args: [
                    parentNode,
                    labelHash,
                    account.address,
                    SEPOLIA_PUBLIC_RESOLVER,
                    0n,
                ],
            });
            row.subnodeTx = subnodeTx;
            await publicClient.waitForTransactionReceipt({hash: subnodeTx});
            step(`      ${subnodeTx}`);

            // Step 2: setAddr to the contract address (coinType 60, ETH).
            step(`    setAddr…`);
            const setAddrTx = await walletClient.writeContract({
                address: SEPOLIA_PUBLIC_RESOLVER,
                abi: RESOLVER_ABI,
                functionName: "setAddr",
                args: [subnode, c.address],
            });
            row.setAddrTx = setAddrTx;
            await publicClient.waitForTransactionReceipt({hash: setAddrTx});
            step(`      ${setAddrTx}`);

            // Step 3: setText("description", …) so the name is self-documenting.
            step(`    setText description…`);
            const setTextTx = await walletClient.writeContract({
                address: SEPOLIA_PUBLIC_RESOLVER,
                abi: RESOLVER_ABI,
                functionName: "setText",
                args: [subnode, "description", c.description],
            });
            row.setTextTx = setTextTx;
            await publicClient.waitForTransactionReceipt({hash: setTextTx});
            step(`      ${setTextTx}`);

            // Verify
            const finalAddr = (await publicClient.readContract({
                address: SEPOLIA_PUBLIC_RESOLVER,
                abi: RESOLVER_ABI,
                functionName: "addr",
                args: [subnode],
            })) as Address;
            row.finalAddr = finalAddr;
            step(`    ✓ ${subname} resolves → ${finalAddr}`);
        } catch (e) {
            const msg = (e as Error).message?.slice(0, 200) ?? String(e);
            row.error = msg;
            step(`    ✗ failed: ${msg}`);
        }

        results.push(row);
        step("");
    }

    return {
        scenario: "ens-name-contracts",
        mode: execute ? "execute" : "dry-run",
        parent: PARENT_NAME,
        parentOwner,
        signer: account.address,
        resolver: SEPOLIA_PUBLIC_RESOLVER,
        results,
    };
}

runMain("ens-name-contracts", main);
