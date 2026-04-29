// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PulseAgentINFT} from "../contracts/inft/PulseAgentINFT.sol";
import {IERC7857} from "../contracts/inft/IERC7857.sol";
import {IERC7857Metadata} from "../contracts/inft/IERC7857Metadata.sol";

/// @notice Tests the ERC-7857 surface + Pulse-specific extensions of
/// PulseAgentINFT. Mirrors the Pulse + PulseGatedHook test style — real
/// signatures via vm.sign, no mocks beyond the signer keypair.
contract PulseAgentINFTTest is Test {
    PulseAgentINFT inft;

    uint256 constant SIGNER_KEY = 0xA11CE;
    uint256 constant ALICE_KEY = 0xB0B;
    address signer;
    address owner;
    address alice;

    function setUp() public {
        signer = vm.addr(SIGNER_KEY);
        alice = vm.addr(ALICE_KEY);
        owner = address(this);
        inft = new PulseAgentINFT("Pulse Agent iNFT", "pAGENT", owner, signer);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    function _preimageProof(bytes32 dataHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encode(address(inft), "preimage", dataHash));
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);
        return abi.encode(dataHash, sig);
    }

    function _transferProof(
        bytes32 oldHash,
        bytes32 newHash,
        address receiver,
        bytes16 sealedKey
    ) internal view returns (bytes memory) {
        bytes32 digest = keccak256(
            abi.encode(address(inft), "transfer", oldHash, newHash, receiver, sealedKey)
        );
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);
        return abi.encode(oldHash, newHash, receiver, sealedKey, sig);
    }

    // ── tests ────────────────────────────────────────────────────────────

    function test_mint_emits_Minted_and_records_state() public {
        bytes32 dh = keccak256("encrypted-blob-v1");
        bytes[] memory proofs = new bytes[](1);
        proofs[0] = _preimageProof(dh);
        string[] memory descriptions = new string[](1);
        descriptions[0] = "pulse-agent-state-v1";

        uint256 tokenId = inft.mint(proofs, descriptions, alice);
        assertEq(tokenId, 1);
        assertEq(inft.ownerOf(tokenId), alice);
        assertEq(inft.dataHashesOf(tokenId).length, 1);
        assertEq(inft.dataHashesOf(tokenId)[0], dh);
        assertEq(inft.dataDescriptionsOf(tokenId)[0], "pulse-agent-state-v1");
    }

    function test_mint_reverts_on_bad_signature() public {
        bytes32 dh = keccak256("blob");
        // Sign with an attacker key, not the signer.
        bytes32 digest = keccak256(abi.encode(address(inft), "preimage", dh));
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xC0FFEE, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);
        bytes[] memory proofs = new bytes[](1);
        proofs[0] = abi.encode(dh, sig);
        string[] memory descs = new string[](1);
        descs[0] = "x";

        vm.expectRevert(PulseAgentINFT.InvalidProof.selector);
        inft.mint(proofs, descs, alice);
    }

    function test_bindPulseAgent_emits_PulseBound() public {
        bytes32 dh = keccak256("blob");
        bytes[] memory proofs = new bytes[](1);
        proofs[0] = _preimageProof(dh);
        string[] memory descs = new string[](1);
        descs[0] = "x";
        uint256 tokenId = inft.mint(proofs, descs, alice);

        bytes32 ensNode = keccak256("pulseagent.eth");
        address pulseAddr = address(0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34);
        uint256 chainId = 11155111;

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit PulseAgentINFT.PulseBound(tokenId, 3906, ensNode, pulseAddr, chainId);
        inft.bindPulseAgent(tokenId, 3906, ensNode, pulseAddr, chainId);

        (uint256 agentId, bytes32 storedNode, address storedPulse, uint256 storedChain) = inft
            .pulseBinding(tokenId);
        assertEq(agentId, 3906);
        assertEq(storedNode, ensNode);
        assertEq(storedPulse, pulseAddr);
        assertEq(storedChain, chainId);
    }

    function test_recordCommitment_appends_history() public {
        bytes32 dh = keccak256("blob");
        bytes[] memory proofs = new bytes[](1);
        proofs[0] = _preimageProof(dh);
        string[] memory descs = new string[](1);
        descs[0] = "x";
        uint256 tokenId = inft.mint(proofs, descs, alice);

        vm.startPrank(alice);
        inft.recordCommitment(tokenId, 9, 11155111);
        inft.recordCommitment(tokenId, 12, 11155111);
        inft.recordCommitment(tokenId, 13, 11155111);
        vm.stopPrank();

        PulseAgentINFT.CommitmentRef[] memory history = inft.commitmentsOf(tokenId);
        assertEq(history.length, 3);
        assertEq(history[0].commitmentId, 9);
        assertEq(history[2].commitmentId, 13);
    }

    function test_recordCommitment_only_owner() public {
        bytes32 dh = keccak256("blob");
        bytes[] memory proofs = new bytes[](1);
        proofs[0] = _preimageProof(dh);
        string[] memory descs = new string[](1);
        descs[0] = "x";
        uint256 tokenId = inft.mint(proofs, descs, alice);

        // Random EOA shouldn't be able to record a commitment.
        vm.expectRevert(PulseAgentINFT.NotOwnerOrAuthorized.selector);
        inft.recordCommitment(tokenId, 999, 11155111);
    }

    function test_authorizeUsage_records_user() public {
        bytes32 dh = keccak256("blob");
        bytes[] memory proofs = new bytes[](1);
        proofs[0] = _preimageProof(dh);
        string[] memory descs = new string[](1);
        descs[0] = "x";
        uint256 tokenId = inft.mint(proofs, descs, alice);

        vm.prank(alice);
        inft.authorizeUsage(tokenId, address(0xBEEF));
        address[] memory users = inft.authorizedUsersOf(tokenId);
        assertEq(users.length, 1);
        assertEq(users[0], address(0xBEEF));
    }

    function test_transfer_with_valid_proof() public {
        bytes32 oldHash = keccak256("v1");
        bytes32 newHash = keccak256("v2");
        bytes16 sealedKey = bytes16(keccak256("k"));

        // Mint with oldHash for alice.
        bytes[] memory mintProofs = new bytes[](1);
        mintProofs[0] = _preimageProof(oldHash);
        string[] memory descs = new string[](1);
        descs[0] = "x";
        uint256 tokenId = inft.mint(mintProofs, descs, alice);

        // Alice transfers to bob (fresh address) with a transfer-validity proof.
        address bob = address(0xCAFE);
        bytes[] memory transferProofs = new bytes[](1);
        transferProofs[0] = _transferProof(oldHash, newHash, bob, sealedKey);

        vm.prank(alice);
        inft.transfer(bob, tokenId, transferProofs);

        assertEq(inft.ownerOf(tokenId), bob);
        assertEq(inft.dataHashesOf(tokenId)[0], newHash);
    }

    function test_clone_inherits_pulseBinding_and_commitments() public {
        bytes32 dh = keccak256("blob");
        bytes[] memory proofs = new bytes[](1);
        proofs[0] = _preimageProof(dh);
        string[] memory descs = new string[](1);
        descs[0] = "x";
        uint256 src = inft.mint(proofs, descs, alice);

        bytes32 ensNode = keccak256("pulseagent.eth");
        vm.startPrank(alice);
        inft.bindPulseAgent(src, 3906, ensNode, address(0xbe1b), 11155111);
        inft.recordCommitment(src, 12, 11155111);
        inft.recordCommitment(src, 13, 11155111);
        vm.stopPrank();

        // Clone for a new recipient.
        bytes32 newHash = keccak256("blob-v2");
        bytes16 sealedKey = bytes16(keccak256("k"));
        address bob = address(0xCAFE);
        bytes[] memory cloneProofs = new bytes[](1);
        cloneProofs[0] = _transferProof(dh, newHash, bob, sealedKey);

        vm.prank(alice);
        uint256 cloned = inft.clone(bob, src, cloneProofs);

        assertEq(inft.ownerOf(cloned), bob);
        assertEq(inft.dataHashesOf(cloned)[0], newHash);
        // Pulse binding cloned.
        (uint256 agentId, , , ) = inft.pulseBinding(cloned);
        assertEq(agentId, 3906);
        // Commitment history cloned.
        PulseAgentINFT.CommitmentRef[] memory history = inft.commitmentsOf(cloned);
        assertEq(history.length, 2);
        assertEq(history[1].commitmentId, 13);
    }

    function test_setSignerProvider_only_owner() public {
        // Caller is `this` which is the deployer/owner — should work.
        inft.setSignerProvider(address(0xBEEF));
        assertEq(inft.signerProvider(), address(0xBEEF));

        vm.prank(alice);
        vm.expectRevert();
        inft.setSignerProvider(address(0xDEAD));
    }

    function test_supportsInterface_includes_IERC7857() public view {
        assertTrue(inft.supportsInterface(type(IERC7857).interfaceId));
        assertTrue(inft.supportsInterface(type(IERC7857Metadata).interfaceId));
    }
}
