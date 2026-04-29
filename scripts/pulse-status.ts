/**
 * Read a Pulse commitment's status + timing from Eth Sepolia.
 *
 *   bun run scripts/pulse-status.ts <commitmentId>
 *
 * Mirrors the pulse-status-check skill recipe. Used by agents (e.g. Hermes
 * via its terminal tool) to inspect commitment state before deciding whether
 * to reveal, swap, or markExpired.
 */
import {createPublicClient, http, parseAbi, type Address} from "viem";
import {sepolia} from "viem/chains";

const RPC = process.env.SEPOLIA_RPC_URL!;
const PULSE = process.env.PULSE_ADDRESS! as Address;
const id = BigInt(process.argv[2] ?? "");
if (!process.argv[2]) {
    console.error("usage: bun run scripts/pulse-status.ts <commitmentId>");
    process.exit(1);
}

const STATUS_NAME = ["Pending", "Revealed", "Violated", "Expired"] as const;

const ABI = parseAbi([
    "function getStatus(uint256 id) view returns (uint8)",
    "function getCommitment(uint256 id) view returns (uint256 agentId, address principal, uint64 commitTime, uint64 executeAfter, uint64 revealDeadline, uint8 status, bytes32 intentHash, bytes32 reasoningCID, address signerProvider)"
]);

const client = createPublicClient({chain: sepolia, transport: http(RPC)});

const [status, c] = await Promise.all([
    client.readContract({address: PULSE, abi: ABI, functionName: "getStatus", args: [id]}),
    client.readContract({address: PULSE, abi: ABI, functionName: "getCommitment", args: [id]})
]);

const [agentId, principal, commitTime, executeAfter, revealDeadline, , intentHash, reasoningCID, signerProvider] = c;
const now = BigInt(Math.floor(Date.now() / 1000));
const inWindow = now >= executeAfter && now < revealDeadline;
const overdue = now >= revealDeadline && status === 0;

console.log(`commitment       #${id}`);
console.log(`status           ${status} (${STATUS_NAME[status] ?? "?"})`);
console.log(`agentId          ${agentId}`);
console.log(`principal        ${principal}`);
console.log(`signerProvider   ${signerProvider}`);
console.log(`intentHash       ${intentHash}`);
console.log(`reasoningCID     ${reasoningCID}`);
console.log(`commitTime       ${commitTime}`);
console.log(`executeAfter     ${executeAfter}  (in ${Number(executeAfter - now)}s${now >= executeAfter ? " — passed" : ""})`);
console.log(`revealDeadline   ${revealDeadline}  (in ${Number(revealDeadline - now)}s${now >= revealDeadline ? " — passed" : ""})`);
console.log(`now              ${now}`);
console.log(`inRevealWindow   ${inWindow}`);
console.log(`overdueExpired   ${overdue}`);
