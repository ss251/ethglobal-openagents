// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IReputationRegistry} from "../interfaces/IReputationRegistry.sol";

/// @notice Reference consumer of Pulse reputation: any protocol gate that wants
/// "only let this agent through if their Pulse-tagged feedback average is above
/// `threshold`" can deploy or `import IPulseGate` and call `assertGate(agentId)`.
///
/// Reads the canonical ERC-8004 ReputationRegistry's `getSummary` with the
/// Pulse contract as the (single) client filter and `tag1 = "pulse"` so the
/// average is computed only over the +100 / -1000 / -500 feedbacks Pulse itself
/// emits on commit-reveal outcomes.
///
/// The pure-view `gate()` is the one external callers usually want; `assertGate`
/// is for in-contract composition; `checkAndLog` is non-view and emits a
/// `GateChecked` event so off-chain indexers can build a "who passed/failed
/// the gate" feed without polling.
interface IPulseGate {
    function gate(uint256 agentId) external view returns (bool approved);

    function assertGate(uint256 agentId) external view;

    function checkAndLog(uint256 agentId) external returns (bool approved);

    function threshold() external view returns (int128);
}

contract PulseGatedGate is Ownable, IPulseGate {
    /// @notice Canonical ERC-8004 ReputationRegistry — Pulse already writes to this.
    IReputationRegistry public immutable reputation;

    /// @notice The Pulse contract whose feedback we filter by. Pulse is the only
    /// `tag1 == "pulse"` writer, but we still pin the client list so a malicious
    /// third party can't farm fake feedback under the same tag.
    address public immutable pulseContract;

    /// @notice Minimum average feedback value (in the mode-decimals scale 8004
    /// returns from `getSummary`) required for `gate(agentId)` to return true.
    int128 public override threshold;

    /// @notice Optional tag2 filter ("" = all pulse feedback; "kept" / "violated"
    /// / "expired" if you want to gate on a single outcome class). Owner-settable.
    string public tag2Filter;

    event ThresholdUpdated(int128 oldThreshold, int128 newThreshold);
    event Tag2FilterUpdated(string oldFilter, string newFilter);
    event GateChecked(uint256 indexed agentId, int128 score, uint64 count, bool approved);

    constructor(
        address _reputation,
        address _pulseContract,
        int128 _threshold,
        address _initialOwner
    ) Ownable(_initialOwner) {
        require(_reputation != address(0), "PulseGatedGate: reputation=0");
        require(_pulseContract != address(0), "PulseGatedGate: pulse=0");
        reputation = IReputationRegistry(_reputation);
        pulseContract = _pulseContract;
        threshold = _threshold;
    }

    /// @notice Pure view — returns true iff the agent has at least one Pulse
    /// feedback and its average is at or above `threshold`. An agent with zero
    /// feedbacks fails the gate (we treat "untracked" as "not approved").
    function gate(uint256 agentId) public view override returns (bool) {
        (uint64 count, int128 summaryValue, ) = _readPulseSummary(agentId);
        if (count == 0) return false;
        return summaryValue >= threshold;
    }

    /// @notice Reverting variant for use inside other contracts:
    /// `IPulseGate(gate).assertGate(agentId)` as a one-liner permission check.
    function assertGate(uint256 agentId) external view override {
        require(gate(agentId), "PulseGatedGate: insufficient reputation");
    }

    /// @notice Same logic as `gate` but non-view: emits `GateChecked` so an
    /// off-chain indexer / The Graph subgraph can stream pass/fail decisions.
    function checkAndLog(uint256 agentId) external override returns (bool approved) {
        (uint64 count, int128 summaryValue, ) = _readPulseSummary(agentId);
        approved = (count > 0 && summaryValue >= threshold);
        emit GateChecked(agentId, summaryValue, count, approved);
    }

    /// @notice Owner can retune the threshold post-deploy as the reputation
    /// distribution settles. Reset to int128 min to disable the gate entirely.
    function setThreshold(int128 newThreshold) external onlyOwner {
        int128 old = threshold;
        threshold = newThreshold;
        emit ThresholdUpdated(old, newThreshold);
    }

    /// @notice Optional: restrict the gate to a single outcome tag.
    function setTag2Filter(string calldata newFilter) external onlyOwner {
        emit Tag2FilterUpdated(tag2Filter, newFilter);
        tag2Filter = newFilter;
    }

    /// @dev Wraps the ERC-8004 `getSummary` call with a single-element client
    /// list pinned to `pulseContract`. Splitting into its own helper keeps the
    /// public functions trivial and lets the test mock one call site.
    function _readPulseSummary(uint256 agentId)
        internal
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        address[] memory clients = new address[](1);
        clients[0] = pulseContract;
        (count, summaryValue, summaryValueDecimals) =
            reputation.getSummary(agentId, clients, "pulse", tag2Filter);
    }
}
