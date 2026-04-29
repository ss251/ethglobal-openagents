#!/usr/bin/env bun
/**
 * ens-set-ensip25 — write the canonical ENSIP-25 agent verification text
 * record on a Pulse-bound ENS name, then read it back to confirm.
 *
 * ENSIP-25 (https://docs.ens.domains/ensip/25) is the explicit standard
 * for binding an ENS name to a specific on-chain agent registry entry
 * (e.g. ERC-8004). Authors: premm.eth, raffy.eth, workemon.eth, ses.eth.
 * Status: draft (October 2025).
 *
 * Record set:
 *   agent-registration[<7930-encoded-registry>][<agentId>] = "1"
 *
 * For Pulse on Eth Sepolia (chainId 11155111), the registry is the canonical
 * ERC-8004 IdentityRegistry at 0x8004A818BFB912233c491871b3d84c89A494BD9e and
 * the agent id is whatever the agent claimed at registration (3906 for
 * pulseagent.eth).
 *
 * Output: BigInt-safe JSON object on stdout with the encoded record key,
 * value, on-chain tx hash, and the verification result. Composes with
 * scripts/ens-bind-demo.ts — run that first to seed the resolver records,
 * then this script to layer on the formal verification.
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    type Address,
    type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";

import {
    encodeERC7930Address,
    ensip25TextRecordKey,
    readENSIP25,
    writeENSIP25,
    ENSIP25_PULSE,
} from "../packages/sdk/src/ensip25.js";

import {loadEnv, requireEnv} from "./_lib/env.js";
import {step, runMain} from "./_lib/output.js";

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
const AGENT_KEY = requireEnv("AGENT_PRIVATE_KEY") as Hex;
const ENS_NAME = arg("name") || process.env.AGENT_ENS_NAME || "pulseagent.eth";
const AGENT_ID = BigInt(arg("id") || process.env.AGENT_ID || "3906");
const REGISTRY: Address =
    (arg("registry") as Address | null) ?? ENSIP25_PULSE.registryAddress;
const REGISTRY_CHAIN = BigInt(
    arg("chain") || ENSIP25_PULSE.registryChainId.toString(),
);
const VALUE = arg("value") || "1";
const execute = flag("execute");

const account = privateKeyToAccount(AGENT_KEY);
const publicClient = createPublicClient({chain: sepolia, transport: http(RPC)});
const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(RPC),
});

async function main() {
    step(`══ ens-set-ensip25 ══`);
    step(`  name              ${ENS_NAME}`);
    step(`  registry          ${REGISTRY}`);
    step(`  registry chainId  ${REGISTRY_CHAIN.toString()}`);
    step(`  agent id          ${AGENT_ID.toString()}`);
    step(`  signer            ${account.address}`);
    step(`  mode              ${execute ? "EXECUTE (writes on chain)" : "DRY-RUN"}`);
    step("");

    const encoded = encodeERC7930Address(REGISTRY_CHAIN, REGISTRY);
    const key = ensip25TextRecordKey({
        registryChainId: REGISTRY_CHAIN,
        registryAddress: REGISTRY,
        agentId: AGENT_ID.toString(),
    });
    step(`  ERC-7930 encoded  ${encoded}`);
    step(`  text record key   ${key}`);
    step(`  text record value "${VALUE}"`);
    step("");

    // Read first to see if the record already exists.
    step(`▸ pre-write read…`);
    const before = await readENSIP25({
        publicClient: publicClient as any,
        name: ENS_NAME,
        registryChainId: REGISTRY_CHAIN,
        registryAddress: REGISTRY,
        agentId: AGENT_ID.toString(),
    });
    step(`  current value: "${before.value || "(empty)"}"  verified: ${before.verified}`);
    step("");

    if (!execute) {
        return {
            scenario: "ens-set-ensip25",
            mode: "dry-run",
            name: ENS_NAME,
            registry: REGISTRY,
            registryChainId: REGISTRY_CHAIN.toString(),
            agentId: AGENT_ID.toString(),
            erc7930: encoded,
            textRecordKey: key,
            valueToSet: VALUE,
            currentValue: before.value,
            currentlyVerified: before.verified,
            hint: "Re-run with --execute to write the record on chain.",
        };
    }

    step(`▸ writing record on chain…`);
    const result = await writeENSIP25({
        publicClient: publicClient as any,
        walletClient: walletClient as any,
        name: ENS_NAME,
        registryChainId: REGISTRY_CHAIN,
        registryAddress: REGISTRY,
        agentId: AGENT_ID.toString(),
        value: VALUE,
    });
    step(`  setText tx → ${result.txHash}`);

    const receipt = await publicClient.waitForTransactionReceipt({
        hash: result.txHash,
    });
    step(`  mined in block ${receipt.blockNumber.toString()} (status: ${receipt.status})`);
    step("");

    step(`▸ post-write verification…`);
    const after = await readENSIP25({
        publicClient: publicClient as any,
        name: ENS_NAME,
        registryChainId: REGISTRY_CHAIN,
        registryAddress: REGISTRY,
        agentId: AGENT_ID.toString(),
    });
    step(`  resolved value: "${after.value}"  verified: ${after.verified}`);

    return {
        scenario: "ens-set-ensip25",
        mode: "execute",
        name: ENS_NAME,
        registry: REGISTRY,
        registryChainId: REGISTRY_CHAIN.toString(),
        agentId: AGENT_ID.toString(),
        erc7930: encoded,
        textRecordKey: result.key,
        valueSet: result.value,
        setTextTx: result.txHash,
        block: receipt.blockNumber.toString(),
        receiptStatus: receipt.status,
        previousValue: before.value,
        resolvedValue: after.value,
        verified: after.verified,
    };
}

runMain("ens-set-ensip25", main);
