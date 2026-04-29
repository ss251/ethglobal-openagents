import { createPublicClient, http, parseAbi, formatUnits, type Address } from "viem";
import { sepolia } from "viem/chains";

const RPC = process.env.SEPOLIA_RPC_URL!;
const POOL_MANAGER = process.env.POOL_MANAGER! as Address;
const TOKEN0 = process.env.POOL_TOKEN0! as Address; // pUSD
const TOKEN1 = process.env.POOL_TOKEN1! as Address; // pWETH
const HOOK = process.env.HOOK_ADDRESS! as Address;
const FEE = Number(process.env.POOL_FEE!);       // 3000
const TICK_SPACING = Number(process.env.POOL_TICK_SPACING!); // 60

// PoolManager.getSlot0 returns (sqrtPriceX96, tick, protocolFee, lpFee)
// We need to compute the PoolId first
import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";

// PoolId = keccak256(abi.encode(PoolKey))
const poolId = keccak256(
  encodeAbiParameters(
    parseAbiParameters("address, address, uint24, int24, address"),
    [TOKEN0, TOKEN1, FEE, TICK_SPACING, HOOK]
  )
);

console.log(`PoolId: ${poolId}`);

const PM_ABI = parseAbi([
  "function getSlot0(bytes32 id) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 id) external view returns (uint128)",
]);

const client = createPublicClient({ chain: sepolia, transport: http(RPC) });

const [slot0, liquidity] = await Promise.all([
  client.readContract({ address: POOL_MANAGER, abi: PM_ABI, functionName: "getSlot0", args: [poolId] }),
  client.readContract({ address: POOL_MANAGER, abi: PM_ABI, functionName: "getLiquidity", args: [poolId] }),
]);

const [sqrtPriceX96, tick, protocolFee, lpFee] = slot0;

// price = (sqrtPriceX96 / 2^96)^2
// This gives price of token1 in terms of token0 (pUSD per pWETH) IF both have same decimals
// Need to check decimals
const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const [dec0, dec1] = await Promise.all([
  client.readContract({ address: TOKEN0, abi: ERC20_ABI, functionName: "decimals" }),
  client.readContract({ address: TOKEN1, abi: ERC20_ABI, functionName: "decimals" }),
]);

const sqrtPrice = Number(sqrtPriceX96) / 2**96;
const rawPrice = sqrtPrice * sqrtPrice;
// Adjust for decimals: price_adjusted = rawPrice * 10^(dec0 - dec1)
const decimalAdjust = 10 ** (Number(dec0) - Number(dec1));
const priceToken1InToken0 = rawPrice * decimalAdjust;

console.log(`sqrtPriceX96:    ${sqrtPriceX96}`);
console.log(`tick:            ${tick}`);
console.log(`liquidity:       ${liquidity}`);
console.log(`pUSD decimals:   ${dec0}`);
console.log(`pWETH decimals:  ${dec1}`);
console.log(`Raw price:       ${rawPrice}`);
console.log(`Price (pUSD/pWETH): ${priceToken1InToken0.toFixed(6)}`);
console.log(`Price (pWETH/pUSD): ${(1/priceToken1InToken0).toFixed(8)}`);
