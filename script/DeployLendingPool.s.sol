// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {PulseGatedLendingPool} from "../contracts/gates/PulseGatedLendingPool.sol";

/// @notice Deploys `PulseGatedLendingPool` against the existing Pulse +
/// PulseGatedGate stack on Eth Sepolia. Defaults to using the deployed
/// pETH / pUSD mocks as collateral / debt at a 1:1 price (matching the
/// initial v4 pool ratio), 50% LTV, 85% liquidation threshold.
///
/// Override via env: COLLATERAL_ASSET, DEBT_ASSET, GATE_ADDRESS,
/// PRICE_1E18, LTV_BPS, LIQ_BPS.
contract DeployLendingPool is Script {
    address constant DEFAULT_COLLATERAL = 0xC8d229E60C4a02fA49D060B1f0b08D956E6ef349; // pWETH
    address constant DEFAULT_DEBT = 0xB1e9c59B50D3b79cA09f4f9fd6ca5cC027EAeDDA;       // pUSD
    address constant DEFAULT_GATE = 0x4d11e22268b8512B01dA7182a52Ba040A0709379;       // PulseGatedGate v0.7.0

    function run() external {
        address collateral = vm.envOr("COLLATERAL_ASSET", DEFAULT_COLLATERAL);
        address debt = vm.envOr("DEBT_ASSET", DEFAULT_DEBT);
        address gate = vm.envOr("GATE_ADDRESS", DEFAULT_GATE);
        uint256 price = vm.envOr("PRICE_1E18", uint256(1e18));
        uint256 ltvBps = vm.envOr("LTV_BPS", uint256(5_000));
        uint256 liqLtvBps = vm.envOr("LIQ_BPS", uint256(8_500));

        vm.startBroadcast();
        PulseGatedLendingPool pool = new PulseGatedLendingPool(
            collateral, debt, gate, price, ltvBps, liqLtvBps
        );
        vm.stopBroadcast();

        console2.log("PulseGatedLendingPool deployed:", address(pool));
        console2.log("  collateral =", collateral);
        console2.log("  debt       =", debt);
        console2.log("  gate       =", gate);
        console2.log("  price 1e18 =", price);
        console2.log("  ltv bps    =", ltvBps);
        console2.log("  liq bps    =", liqLtvBps);
    }
}
