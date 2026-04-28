// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IERC8004} from "./interfaces/IERC8004.sol";
import {IReputationRegistry} from "./interfaces/IReputationRegistry.sol";

/// @title Pulse — galaxy-brain-resistant agent commitments
/// @notice Agents commit to a hashed action with sealed-inference reasoning at T,
///         then must reveal the matching action between T+executeAfter and T+revealDeadline.
///         A failure to reveal, or a reveal that doesn't match the committed hash,
///         penalizes the agent's ERC-8004 reputation.
contract Pulse is ReentrancyGuard {
    using MessageHashUtils for bytes32;

    enum Status {
        Pending,
        Revealed,
        Violated,
        Expired
    }

    struct Commitment {
        uint256 agentId;
        address principal;
        uint64 commitTime;
        uint64 executeAfter;
        uint64 revealDeadline;
        Status status;
        bytes32 intentHash;
        bytes32 reasoningCID;
        address signerProvider;
    }

    IERC8004 public immutable identityRegistry;
    IReputationRegistry public immutable reputation;

    mapping(uint256 => Commitment) public commitments;
    uint256 public nextId = 1;

    event Committed(
        uint256 indexed id,
        uint256 indexed agentId,
        bytes32 intentHash,
        bytes32 reasoningCID,
        uint64 executeAfter,
        uint64 revealDeadline,
        address signerProvider
    );

    event Revealed(uint256 indexed id, uint256 indexed agentId, bytes actionData);

    event Violated(uint256 indexed id, uint256 indexed agentId, bytes32 computedHash);

    event Expired(uint256 indexed id, uint256 indexed agentId);

    error NotAgentOwner();
    error TooEarly();
    error TooLate();
    error AlreadyResolved();
    error InvalidProviderSig();
    error NotReadyToExpire();

    constructor(address _identityRegistry, address _reputation) {
        identityRegistry = IERC8004(_identityRegistry);
        reputation = IReputationRegistry(_reputation);
    }

    /// @notice Commit to an action represented by `intentHash`.
    /// `sealedSig` is verified via OpenZeppelin SignatureChecker (supports both
    /// ECDSA EOAs and ERC-1271 contract signers) over the EIP-191 personal_sign
    /// hash of keccak256(abi.encode(agentId, intentHash, reasoningCID, executeAfter)).
    function commit(
        uint256 agentId,
        bytes32 intentHash,
        bytes32 reasoningCID,
        uint64 executeAfter,
        uint64 revealWindow,
        address signerProvider,
        bytes calldata sealedSig
    ) external nonReentrant returns (uint256 id) {
        if (!identityRegistry.isAuthorizedOrOwner(msg.sender, agentId)) revert NotAgentOwner();

        bytes32 payload = keccak256(abi.encode(agentId, intentHash, reasoningCID, executeAfter));
        bytes32 ethHash = payload.toEthSignedMessageHash();
        if (!SignatureChecker.isValidSignatureNow(signerProvider, ethHash, sealedSig)) {
            revert InvalidProviderSig();
        }

        id = nextId++;
        uint64 deadline = executeAfter + revealWindow;
        commitments[id] = Commitment({
            agentId: agentId,
            principal: msg.sender,
            commitTime: uint64(block.timestamp),
            executeAfter: executeAfter,
            revealDeadline: deadline,
            status: Status.Pending,
            intentHash: intentHash,
            reasoningCID: reasoningCID,
            signerProvider: signerProvider
        });

        emit Committed(id, agentId, intentHash, reasoningCID, executeAfter, deadline, signerProvider);
    }

    /// @notice Reveal the action data; must match the committed intentHash.
    function reveal(
        uint256 id,
        bytes32 nonce,
        bytes calldata actionData
    ) external nonReentrant returns (bool kept) {
        Commitment storage c = commitments[id];
        if (c.status != Status.Pending) revert AlreadyResolved();
        if (block.timestamp < c.executeAfter) revert TooEarly();
        if (block.timestamp >= c.revealDeadline) revert TooLate();

        bytes32 computed = keccak256(abi.encodePacked(nonce, actionData));
        if (computed != c.intentHash) {
            c.status = Status.Violated;
            _scoreAgent(c.agentId, -1000, 2, "violated", c.intentHash);
            emit Violated(id, c.agentId, computed);
            return false;
        }

        c.status = Status.Revealed;
        _scoreAgent(c.agentId, 100, 0, "kept", c.intentHash);
        emit Revealed(id, c.agentId, actionData);
        return true;
    }

    /// @notice Mark a commitment expired if the agent never revealed.
    /// Anyone may call once revealDeadline has passed (an offchain scheduler,
    /// the principal, or any concerned third party).
    function markExpired(uint256 id) external nonReentrant {
        Commitment storage c = commitments[id];
        if (c.status != Status.Pending) revert AlreadyResolved();
        if (block.timestamp < c.revealDeadline) revert NotReadyToExpire();

        c.status = Status.Expired;
        _scoreAgent(c.agentId, -500, 2, "expired", c.intentHash);
        emit Expired(id, c.agentId);
    }

    function getStatus(uint256 id) external view returns (Status) {
        return commitments[id].status;
    }

    function _scoreAgent(
        uint256 agentId,
        int128 value,
        uint8 decimals,
        string memory tag2,
        bytes32 feedbackHash
    ) internal {
        // Wrapped in try/catch so reputation reverts never block the commitment lifecycle.
        try reputation.giveFeedback(
            agentId,
            value,
            decimals,
            "pulse",
            tag2,
            "",
            "",
            feedbackHash
        ) {} catch {}
    }
}
