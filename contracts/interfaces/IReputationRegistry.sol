// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Subset of the ERC-8004 ReputationRegistry public ABI used by Pulse.
/// Matches the deployed contracts at:
///   Base Sepolia / Ethereum Sepolia: 0x8004B663056A597Dffe9eCcC1965A193B7388713
/// Reference implementation:
///   https://github.com/erc-8004/erc-8004-contracts (ReputationRegistryUpgradeable.sol)
interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}
