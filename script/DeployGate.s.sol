// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {PulseGatedGate} from "../contracts/gates/PulseGatedGate.sol";

/// @notice Deploys `PulseGatedGate` — the reference consumer that lets any
/// protocol gate behavior on Pulse-tagged ERC-8004 reputation.
/// Defaults to the deployed Eth Sepolia ReputationRegistry + Pulse address.
contract DeployGate is Script {
    address constant DEFAULT_REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    address constant DEFAULT_PULSE = 0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34;

    function run() external {
        address reputation = vm.envOr("REPUTATION_REGISTRY", DEFAULT_REPUTATION);
        address pulse = vm.envOr("PULSE_ADDRESS", DEFAULT_PULSE);
        int128 threshold = int128(int256(vm.envOr("GATE_THRESHOLD", uint256(50))));
        address owner = vm.envOr("GATE_OWNER", msg.sender);

        vm.startBroadcast();
        PulseGatedGate gate = new PulseGatedGate(reputation, pulse, threshold, owner);
        vm.stopBroadcast();

        console2.log("PulseGatedGate deployed:", address(gate));
        console2.log("  reputation =", reputation);
        console2.log("  pulse      =", pulse);
        console2.log("  threshold  =", threshold);
        console2.log("  owner      =", owner);
    }
}
