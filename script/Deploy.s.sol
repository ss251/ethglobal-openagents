// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {Pulse} from "../contracts/Pulse.sol";

/// @notice Deploys Pulse against canonical ERC-8004 registries.
/// Defaults are the deployed addresses on Base Sepolia / Ethereum Sepolia (chainId 84532 / 11155111).
contract Deploy is Script {
    address constant DEFAULT_IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant DEFAULT_REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    function run() external {
        address identity = vm.envOr("IDENTITY_REGISTRY", DEFAULT_IDENTITY);
        address reputation = vm.envOr("REPUTATION_REGISTRY", DEFAULT_REPUTATION);

        vm.startBroadcast();
        Pulse pulse = new Pulse(identity, reputation);
        vm.stopBroadcast();

        console2.log("Pulse deployed at:", address(pulse));
        console2.log("Identity Registry:", identity);
        console2.log("Reputation Registry:", reputation);
    }
}
