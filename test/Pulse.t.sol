// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {Pulse} from "../contracts/Pulse.sol";
import {MockIdentityRegistry} from "../contracts/mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "../contracts/mocks/MockReputationRegistry.sol";

contract PulseTest is Test {
    Pulse internal pulse;
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;

    Vm.Wallet internal provider;
    Vm.Wallet internal principal;

    uint256 internal constant AGENT_ID = 42;

    function setUp() public {
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();
        pulse = new Pulse(address(identity), address(reputation));

        provider = vm.createWallet("provider");
        principal = vm.createWallet("agent-principal");

        identity.setOwner(AGENT_ID, principal.addr);
    }

    function _signCommit(
        uint256 agentId,
        bytes32 intentHash,
        bytes32 reasoningCID,
        uint64 executeAfter,
        Vm.Wallet memory signer
    ) internal pure returns (bytes memory) {
        bytes32 payload = keccak256(abi.encode(agentId, intentHash, reasoningCID, executeAfter));
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payload));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signer.privateKey, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function test_commitAndKeep() public {
        bytes32 nonce = bytes32(uint256(0xdead));
        bytes memory action = abi.encode(address(0xbeef), uint256(100));
        bytes32 intentHash = keccak256(abi.encodePacked(nonce, action));
        bytes32 reasoningCID = bytes32(uint256(1));
        uint64 executeAfter = uint64(block.timestamp + 1 hours);
        uint64 revealWindow = 1 hours;

        bytes memory sig = _signCommit(AGENT_ID, intentHash, reasoningCID, executeAfter, provider);

        vm.prank(principal.addr);
        uint256 id = pulse.commit(
            AGENT_ID,
            intentHash,
            reasoningCID,
            executeAfter,
            revealWindow,
            provider.addr,
            sig
        );
        assertEq(id, 1);
        assertEq(uint256(pulse.getStatus(id)), uint256(Pulse.Status.Pending));

        vm.warp(executeAfter + 1);
        bool kept = pulse.reveal(id, nonce, action);
        assertTrue(kept);
        assertEq(uint256(pulse.getStatus(id)), uint256(Pulse.Status.Revealed));
    }

    function test_revertWhenIntentMismatched() public {
        bytes32 nonce = bytes32(uint256(0xc0ffee));
        bytes memory action = abi.encode(address(0xb0b), uint256(50));
        bytes32 intentHash = keccak256(abi.encodePacked(nonce, action));
        uint64 executeAfter = uint64(block.timestamp + 30 minutes);
        uint64 revealWindow = 30 minutes;

        bytes memory sig = _signCommit(AGENT_ID, intentHash, bytes32(0), executeAfter, provider);

        vm.prank(principal.addr);
        uint256 id = pulse.commit(AGENT_ID, intentHash, bytes32(0), executeAfter, revealWindow, provider.addr, sig);

        vm.warp(executeAfter + 1);
        bytes memory wrongAction = abi.encode(address(0xb0b), uint256(999));
        bool kept = pulse.reveal(id, nonce, wrongAction);
        assertFalse(kept);
        assertEq(uint256(pulse.getStatus(id)), uint256(Pulse.Status.Violated));
    }

    function test_revertWhenRevealTooEarly() public {
        bytes32 nonce = bytes32(uint256(1));
        bytes memory action = "irrelevant";
        bytes32 intentHash = keccak256(abi.encodePacked(nonce, action));
        uint64 executeAfter = uint64(block.timestamp + 1 hours);

        bytes memory sig = _signCommit(AGENT_ID, intentHash, bytes32(0), executeAfter, provider);

        vm.prank(principal.addr);
        uint256 id = pulse.commit(AGENT_ID, intentHash, bytes32(0), executeAfter, 1 hours, provider.addr, sig);

        vm.expectRevert(Pulse.TooEarly.selector);
        pulse.reveal(id, nonce, action);
    }

    function test_expireOnNoReveal() public {
        bytes32 nonce = bytes32(uint256(7));
        bytes32 intentHash = keccak256(abi.encodePacked(nonce, bytes("noop")));
        uint64 executeAfter = uint64(block.timestamp + 10 minutes);
        uint64 revealWindow = 5 minutes;

        bytes memory sig = _signCommit(AGENT_ID, intentHash, bytes32(0), executeAfter, provider);

        vm.prank(principal.addr);
        uint256 id = pulse.commit(AGENT_ID, intentHash, bytes32(0), executeAfter, revealWindow, provider.addr, sig);

        vm.warp(executeAfter + revealWindow + 1);
        pulse.markExpired(id);
        assertEq(uint256(pulse.getStatus(id)), uint256(Pulse.Status.Expired));
    }

    function test_revertWhenWrongSigner() public {
        Vm.Wallet memory imposter = vm.createWallet("imposter");

        bytes32 intentHash = bytes32(uint256(0xabcdef));
        uint64 executeAfter = uint64(block.timestamp + 1 hours);

        bytes memory sig = _signCommit(AGENT_ID, intentHash, bytes32(0), executeAfter, imposter);

        vm.prank(principal.addr);
        vm.expectRevert(Pulse.InvalidProviderSig.selector);
        pulse.commit(AGENT_ID, intentHash, bytes32(0), executeAfter, 1 hours, provider.addr, sig);
    }

    function test_revertWhenNotAgentOwner() public {
        bytes32 intentHash = bytes32(uint256(0xfeed));
        uint64 executeAfter = uint64(block.timestamp + 1 hours);

        bytes memory sig = _signCommit(AGENT_ID, intentHash, bytes32(0), executeAfter, provider);

        vm.prank(address(0xdeadbeef));
        vm.expectRevert(Pulse.NotAgentOwner.selector);
        pulse.commit(AGENT_ID, intentHash, bytes32(0), executeAfter, 1 hours, provider.addr, sig);
    }
}
