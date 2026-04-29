// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PulseAgentINFT} from "../contracts/inft/PulseAgentINFT.sol";

/// @notice Deploy PulseAgentINFT on 0G Galileo testnet (chainId 16602).
///
/// Required env:
///   DEPLOYER_KEY        — funded with OG (faucet at https://faucet.0g.ai/)
///   ZG_RPC_URL          — https://evmrpc-testnet.0g.ai (default)
///   INFT_NAME           — defaults to "Pulse Agent iNFT"
///   INFT_SYMBOL         — defaults to "pAGENT"
///   INFT_OWNER          — admin EOA (defaults to deployer)
///   INFT_SIGNER         — TEE signer / DEMO_TEE_SIGNER address (must match Pulse signerProvider)
///
/// Run:
///   forge script script/DeployINFT.s.sol:DeployINFT \
///     --rpc-url $ZG_RPC_URL --broadcast --legacy --skip-simulation
///
/// `--legacy` because 0G Galileo doesn't accept EIP-1559 fee fields from
/// foundry's default broadcast path; `--skip-simulation` because forge's
/// default simulator can't bind to the 0G chain at the same time as
/// broadcasting (the testnet RPC rejects parallel eth_call + sendRawTx).
contract DeployINFT is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(deployerKey);

        string memory iName = vm.envOr("INFT_NAME", string("Pulse Agent iNFT"));
        string memory iSymbol = vm.envOr("INFT_SYMBOL", string("pAGENT"));
        address owner = vm.envOr("INFT_OWNER", deployer);
        address signer = vm.envAddress("INFT_SIGNER");

        console2.log("== Deploy PulseAgentINFT on 0G Galileo ==");
        console2.log("  deployer    :", deployer);
        console2.log("  owner       :", owner);
        console2.log("  signer      :", signer);
        console2.log("  name/symbol :", iName, "/", iSymbol);

        vm.startBroadcast(deployerKey);
        PulseAgentINFT inft = new PulseAgentINFT(iName, iSymbol, owner, signer);
        vm.stopBroadcast();

        console2.log("  contract    :", address(inft));
        console2.log("  block       :", block.number);
        console2.log("  Add to .env : INFT_ADDRESS=", address(inft));
    }
}
