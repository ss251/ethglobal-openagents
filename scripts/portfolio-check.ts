import { createPublicClient, http, parseAbi, formatEther, formatUnits, type Address } from "viem";
import { sepolia } from "viem/chains";

const RPC = process.env.SEPOLIA_RPC_URL!;
const WALLET = "0x30cB0080bFE9bB98d900726Fd3012175ee3D397c" as Address;
const TOKEN0 = process.env.POOL_TOKEN0! as Address;
const TOKEN1 = process.env.POOL_TOKEN1! as Address;

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

const client = createPublicClient({ chain: sepolia, transport: http(RPC) });

const [ethBal, t0Bal, t1Bal, t0Dec, t1Dec, t0Sym, t1Sym, t0Name, t1Name] = await Promise.all([
  client.getBalance({ address: WALLET }),
  client.readContract({ address: TOKEN0, abi: ERC20_ABI, functionName: "balanceOf", args: [WALLET] }),
  client.readContract({ address: TOKEN1, abi: ERC20_ABI, functionName: "balanceOf", args: [WALLET] }),
  client.readContract({ address: TOKEN0, abi: ERC20_ABI, functionName: "decimals" }),
  client.readContract({ address: TOKEN1, abi: ERC20_ABI, functionName: "decimals" }),
  client.readContract({ address: TOKEN0, abi: ERC20_ABI, functionName: "symbol" }),
  client.readContract({ address: TOKEN1, abi: ERC20_ABI, functionName: "symbol" }),
  client.readContract({ address: TOKEN0, abi: ERC20_ABI, functionName: "name" }),
  client.readContract({ address: TOKEN1, abi: ERC20_ABI, functionName: "name" }),
]);

console.log("=== PULSE AGENT PORTFOLIO ===");
console.log(`Wallet:     ${WALLET}`);
console.log(`Chain:      Sepolia (11155111)`);
console.log(`Agent ID:   3906 (ERC-8004)`);
console.log("");
console.log("--- Balances ---");
console.log(`ETH (gas):  ${formatEther(ethBal)} ETH`);
console.log(`${t0Sym} (${t0Name}): ${formatUnits(t0Bal, t0Dec)}`);
console.log(`${t1Sym} (${t1Name}): ${formatUnits(t1Bal, t1Dec)}`);
console.log("");
console.log("--- Contracts ---");
console.log(`Pulse:      ${process.env.PULSE_ADDRESS}`);
console.log(`Hook:       0x274b3c0f55c2db8c392418649c1eb3aad1ecc080`);
console.log(`Pool Mgr:   ${process.env.POOL_MANAGER}`);
console.log(`SwapTest:   ${process.env.POOL_SWAP_TEST}`);
console.log(`${t0Sym}:       ${TOKEN0}`);
console.log(`${t1Sym}:      ${TOKEN1}`);
