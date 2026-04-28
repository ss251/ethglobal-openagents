// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import {Pulse} from "../contracts/Pulse.sol";
import {PulseGatedHook} from "../contracts/hooks/PulseGatedHook.sol";

/// @notice Deploys PulseGatedHook against an existing Pulse + Uniswap v4 PoolManager.
///         The hook address must encode BEFORE_SWAP_FLAG in its lower 14 bits — we
///         mine a CREATE2 salt to satisfy that constraint, then deploy through the
///         Foundry CREATE2 deployer proxy.
contract DeployHook is Script {
    /// Foundry / forge-std default CREATE2 deployer
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        IPoolManager manager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        Pulse pulse = Pulse(vm.envAddress("PULSE"));

        bytes memory constructorArgs = abi.encode(manager, pulse);
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);

        (address expected, bytes32 salt) = HookMiner.find(
            CREATE2_DEPLOYER,
            flags,
            type(PulseGatedHook).creationCode,
            constructorArgs
        );

        vm.startBroadcast();
        PulseGatedHook hook = new PulseGatedHook{salt: salt}(manager, pulse);
        vm.stopBroadcast();

        require(address(hook) == expected, "hook address mismatch");

        console2.log("PulseGatedHook deployed at:", address(hook));
        console2.log("Salt:", uint256(salt));
        console2.log("Pool Manager:", address(manager));
        console2.log("Pulse:", address(pulse));
    }
}
