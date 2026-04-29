// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {PulseGatedGate, IPulseGate} from "../contracts/gates/PulseGatedGate.sol";
import {IReputationRegistry} from "../contracts/interfaces/IReputationRegistry.sol";

contract PulseGatedGateTest is Test {
    PulseGatedGate gate;

    address constant REGISTRY = address(0xBEEF);
    address constant PULSE = address(0xBE1B);
    address constant OWNER = address(0xA110);
    address constant STRANGER = address(0xBADBAD);

    uint256 constant AGENT_ID = 3906;

    int128 constant INITIAL_THRESHOLD = 50;

    event ThresholdUpdated(int128 oldThreshold, int128 newThreshold);
    event Tag2FilterUpdated(string oldFilter, string newFilter);
    event GateChecked(uint256 indexed agentId, int128 score, uint64 count, bool approved);

    function setUp() public {
        vm.prank(OWNER);
        gate = new PulseGatedGate(REGISTRY, PULSE, INITIAL_THRESHOLD, OWNER);
    }

    function _mockSummary(string memory tag2, uint64 count, int128 summaryValue, uint8 dec) internal {
        address[] memory clients = new address[](1);
        clients[0] = PULSE;
        vm.mockCall(
            REGISTRY,
            abi.encodeWithSelector(
                IReputationRegistry.getSummary.selector, AGENT_ID, clients, "pulse", tag2
            ),
            abi.encode(count, summaryValue, dec)
        );
    }

    // --- gate / assertGate -------------------------------------------------

    function test_gate_passes_above_threshold() public {
        _mockSummary("", 12, int128(80), 0);
        assertTrue(gate.gate(AGENT_ID));
    }

    function test_gate_passes_at_threshold() public {
        _mockSummary("", 5, INITIAL_THRESHOLD, 0);
        assertTrue(gate.gate(AGENT_ID));
    }

    function test_gate_fails_below_threshold() public {
        _mockSummary("", 7, int128(-200), 2);
        assertFalse(gate.gate(AGENT_ID));
    }

    function test_gate_fails_when_no_feedback_yet() public {
        // 8004 returns count=0 for an agent with no matching feedback. Untracked
        // agents must not pass even if threshold is non-positive.
        _mockSummary("", 0, int128(0), 0);
        assertFalse(gate.gate(AGENT_ID));
    }

    function test_assertGate_reverts_on_low_score() public {
        _mockSummary("", 3, int128(-10), 2);
        vm.expectRevert("PulseGatedGate: insufficient reputation");
        gate.assertGate(AGENT_ID);
    }

    function test_assertGate_reverts_on_no_feedback() public {
        _mockSummary("", 0, int128(0), 0);
        vm.expectRevert("PulseGatedGate: insufficient reputation");
        gate.assertGate(AGENT_ID);
    }

    // --- checkAndLog (non-view, emits) -------------------------------------

    function test_checkAndLog_emits_GateChecked_on_pass() public {
        _mockSummary("", 9, int128(120), 0);
        vm.expectEmit(true, false, false, true, address(gate));
        emit GateChecked(AGENT_ID, int128(120), uint64(9), true);
        bool approved = gate.checkAndLog(AGENT_ID);
        assertTrue(approved);
    }

    function test_checkAndLog_emits_GateChecked_on_fail() public {
        _mockSummary("", 4, int128(-50), 2);
        vm.expectEmit(true, false, false, true, address(gate));
        emit GateChecked(AGENT_ID, int128(-50), uint64(4), false);
        bool approved = gate.checkAndLog(AGENT_ID);
        assertFalse(approved);
    }

    // --- owner-only setters ------------------------------------------------

    function test_setThreshold_only_owner() public {
        vm.prank(STRANGER);
        vm.expectRevert();
        gate.setThreshold(999);
    }

    function test_setThreshold_emits_and_applies() public {
        vm.expectEmit(false, false, false, true, address(gate));
        emit ThresholdUpdated(INITIAL_THRESHOLD, int128(999));
        vm.prank(OWNER);
        gate.setThreshold(999);
        assertEq(gate.threshold(), int128(999));
    }

    function test_setTag2Filter_routes_correct_summary_call() public {
        vm.prank(OWNER);
        gate.setTag2Filter("kept");
        _mockSummary("kept", 6, int128(100), 0);
        // sanity: call gate, mocked answer should drive the result
        assertTrue(gate.gate(AGENT_ID));
        // and the no-filter mock from before is now ignored
        _mockSummary("", 1, int128(-1000), 2);
        assertTrue(gate.gate(AGENT_ID));
    }

    function test_setTag2Filter_only_owner() public {
        vm.prank(STRANGER);
        vm.expectRevert();
        gate.setTag2Filter("violated");
    }

    // --- constructor invariants -------------------------------------------

    function test_ctor_rejects_zero_addresses() public {
        vm.expectRevert("PulseGatedGate: reputation=0");
        new PulseGatedGate(address(0), PULSE, INITIAL_THRESHOLD, OWNER);

        vm.expectRevert("PulseGatedGate: pulse=0");
        new PulseGatedGate(REGISTRY, address(0), INITIAL_THRESHOLD, OWNER);
    }

    function test_ctor_stores_immutables() public view {
        assertEq(address(gate.reputation()), REGISTRY);
        assertEq(gate.pulseContract(), PULSE);
        assertEq(gate.threshold(), INITIAL_THRESHOLD);
        assertEq(gate.owner(), OWNER);
    }
}
