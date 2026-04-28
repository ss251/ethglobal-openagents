// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Subset of the ERC-8004 IdentityRegistry public ABI used by Pulse.
/// Matches the deployed contracts at:
///   Base Sepolia / Ethereum Sepolia: 0x8004A818BFB912233c491871b3d84c89A494BD9e
/// Reference implementation:
///   https://github.com/erc-8004/erc-8004-contracts (IdentityRegistryUpgradeable.sol)
interface IERC8004 {
    function ownerOf(uint256 agentId) external view returns (address);

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);

    function getApproved(uint256 agentId) external view returns (address);
}
