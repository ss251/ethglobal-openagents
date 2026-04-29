// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IReputationRegistry} from "../interfaces/IReputationRegistry.sol";

contract MockReputationRegistry is IReputationRegistry {
    event Recorded(uint256 indexed agentId, int128 value, string tag1, string tag2, bytes32 feedbackHash);

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8,
        string memory tag1,
        string memory tag2,
        string memory,
        string memory,
        bytes32 feedbackHash
    ) external {
        emit Recorded(agentId, value, tag1, tag2, feedbackHash);
    }

    function getSummary(uint256, address[] calldata, string calldata, string calldata)
        external
        pure
        returns (uint64, int128, uint8)
    {
        return (0, 0, 0);
    }
}
