// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import {MockERC20} from "../contracts/mocks/MockERC20.sol";

/// @notice Phase-2 deployment: 2 mock ERC20s, initialize a v4 pool keyed to
///         PulseGatedHook, seed with a wide liquidity position.
///
/// Reads from env:
///   POOL_MANAGER         — Base Sepolia v4 PoolManager
///   HOOK_ADDRESS         — already-deployed PulseGatedHook
///   MODIFY_LIQUIDITY_TEST — canonical PoolModifyLiquidityTest router
///
/// Writes nothing — caller should pipe the script's logs into deployments/base-sepolia.json.
contract Phase2 is Script {
    /// 1:1 price → sqrt(1) * 2^96
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    /// fee + tickSpacing chosen for permissive liquidity provisioning
    uint24 internal constant LP_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    int24 internal constant TICK_LOWER = -887220;
    int24 internal constant TICK_UPPER = 887220;
    /// 1M tokens per side seeded for testing — well over our trade sizes
    uint256 internal constant SEED_AMOUNT = 1_000_000 ether;
    /// liquidity amount roughly equivalent to 100 of each token at 1:1
    int256 internal constant LIQUIDITY_DELTA = 100 ether;

    function run() external {
        IPoolManager manager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        IHooks hook = IHooks(vm.envAddress("HOOK_ADDRESS"));
        PoolModifyLiquidityTest router = PoolModifyLiquidityTest(vm.envAddress("MODIFY_LIQUIDITY_TEST"));

        vm.startBroadcast();

        // Deploy and sort tokens so currency0 < currency1
        MockERC20 a = new MockERC20("Pulse Mock USD", "pUSD");
        MockERC20 b = new MockERC20("Pulse Mock WETH", "pWETH");
        (MockERC20 token0, MockERC20 token1) = address(a) < address(b) ? (a, b) : (b, a);

        token0.mint(msg.sender, SEED_AMOUNT);
        token1.mint(msg.sender, SEED_AMOUNT);

        token0.approve(address(router), type(uint256).max);
        token1.approve(address(router), type(uint256).max);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: hook
        });

        manager.initialize(key, SQRT_PRICE_1_1);

        ModifyLiquidityParams memory params = ModifyLiquidityParams({
            tickLower: TICK_LOWER,
            tickUpper: TICK_UPPER,
            liquidityDelta: LIQUIDITY_DELTA,
            salt: bytes32(0)
        });

        router.modifyLiquidity(key, params, "");

        vm.stopBroadcast();

        console2.log("token0 (currency0):", address(token0));
        console2.log("token1 (currency1):", address(token1));
        console2.log("hook              :", address(hook));
        console2.log("fee               :", LP_FEE);
        console2.log("tickSpacing       :", TICK_SPACING);
        console2.log("liquidity seeded  :", uint256(LIQUIDITY_DELTA));
    }
}
