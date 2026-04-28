// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC8004} from "../interfaces/IERC8004.sol";

contract MockIdentityRegistry is IERC8004 {
    mapping(uint256 => address) public owners;

    function setOwner(uint256 agentId, address owner) external {
        owners[agentId] = owner;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return owners[agentId];
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        return owners[agentId] == spender;
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }
}
