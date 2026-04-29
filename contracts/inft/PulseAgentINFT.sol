// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IERC7857} from "./IERC7857.sol";
import {IERC7857Metadata} from "./IERC7857Metadata.sol";
import {
    IERC7857DataVerifier,
    PreimageProofOutput,
    TransferValidityProofOutput
} from "./IERC7857DataVerifier.sol";

/// @title PulseAgentINFT — ERC-7857 (intelligent NFT) issued by Pulse Protocol.
///
/// One iNFT per agent. The encrypted state blob lives off-chain on 0G Storage;
/// this contract anchors the blob's hash on chain and gates ownership behind
/// ECDSA proofs from a `signerProvider` (the same TEE-attested key role Pulse
/// already uses for sealed reasoning, so an integrator wires Pulse + iNFT
/// against a single trust anchor).
///
/// Pulse-specific bindings the contract exposes alongside the standard
/// IERC7857 surface:
///   - `bindPulseAgent(tokenId, agentId, ens, pulse, chainId)` — link the iNFT
///     to its Pulse Eth-Sepolia identity (ERC-8004 token id, ENS name, Pulse
///     contract address). Emits `PulseBound` so cross-chain indexers can pick
///     it up without parsing tokenURI.
///   - `recordCommitment(tokenId, commitmentId)` — append a Pulse commitment
///     id to the iNFT's on-chain history. The new owner of the iNFT inherits
///     the rep history that committed under that agent.
///
/// The verifier role (IERC7857DataVerifier) is implemented inline — the
/// contract is its own verifier. Saves a deploy + keeps the trust anchor in
/// one address. For production with a real TEE/ZKP oracle, swap by deploying
/// a separate `Verifier` and changing `_verifier`.
contract PulseAgentINFT is ERC721, Ownable, IERC7857, IERC7857Metadata, IERC7857DataVerifier {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    /// @dev Authorized signer for preimage / transfer-validity proofs. Mirrors
    /// Pulse's signerProvider pattern.
    address public signerProvider;

    uint256 private _nextTokenId;

    mapping(uint256 => bytes32[]) private _dataHashes;
    mapping(uint256 => string[]) private _dataDescriptions;
    mapping(uint256 => address[]) private _authorized;
    mapping(uint256 => mapping(address => bool)) private _authorizedSet;

    /// @dev Pulse identity binding for an iNFT.
    struct PulseBinding {
        uint256 agentId;        // ERC-8004 IdentityRegistry token id
        bytes32 ensNode;        // namehash of the ENS name (e.g. pulseagent.eth)
        address pulse;          // Pulse.sol address
        uint256 pulseChainId;   // chain where Pulse + ERC-8004 live (Eth Sepolia = 11155111)
    }
    mapping(uint256 => PulseBinding) public pulseBinding;

    /// @dev Committed action history for an iNFT — the new owner inherits this
    /// trail. Stores Pulse commitmentId + chainId so off-chain readers can pull
    /// the full provenance.
    struct CommitmentRef {
        uint256 commitmentId;
        uint256 pulseChainId;
        uint64 recordedAt;
    }
    mapping(uint256 => CommitmentRef[]) private _commitments;

    event PulseBound(
        uint256 indexed tokenId,
        uint256 indexed agentId,
        bytes32 ensNode,
        address pulse,
        uint256 pulseChainId
    );

    event CommitmentRecorded(
        uint256 indexed tokenId,
        uint256 indexed commitmentId,
        uint256 pulseChainId,
        uint256 totalCommitments
    );

    event SignerProviderUpdated(address indexed oldSigner, address indexed newSigner);

    error InvalidProof();
    error NotOwnerOrAuthorized();

    constructor(
        string memory _name,
        string memory _symbol,
        address _initialOwner,
        address _signerProvider
    ) ERC721(_name, _symbol) Ownable(_initialOwner) {
        require(_signerProvider != address(0), "signer=0");
        signerProvider = _signerProvider;
    }

    // ────────────────────────────────────────────────────────────────
    // ERC-7857 core
    // ────────────────────────────────────────────────────────────────

    function verifier() external view returns (IERC7857DataVerifier) {
        return IERC7857DataVerifier(address(this));
    }

    function mint(
        bytes[] calldata _proofs,
        string[] calldata _descriptions,
        address _to
    ) external payable returns (uint256 tokenId) {
        require(_proofs.length == _descriptions.length, "len mismatch");
        address recipient = _to == address(0) ? msg.sender : _to;

        PreimageProofOutput[] memory outputs = _verifyPreimage(_proofs);
        bytes32[] memory hashes = new bytes32[](outputs.length);
        for (uint256 i = 0; i < outputs.length; i++) {
            if (!outputs[i].isValid) revert InvalidProof();
            hashes[i] = outputs[i].dataHash;
        }

        tokenId = ++_nextTokenId;
        _safeMint(recipient, tokenId);
        _dataHashes[tokenId] = hashes;
        _dataDescriptions[tokenId] = _descriptions;

        emit Minted(tokenId, msg.sender, recipient, hashes, _descriptions);
    }

    function transfer(
        address _to,
        uint256 _tokenId,
        bytes[] calldata _proofs
    ) external {
        if (msg.sender != ownerOf(_tokenId)) revert NotOwnerOrAuthorized();

        TransferValidityProofOutput[] memory outputs = _verifyTransferValidity(_proofs);
        require(outputs.length == _dataHashes[_tokenId].length, "len");

        bytes32[] memory newHashes = new bytes32[](outputs.length);
        bytes16[] memory sealedKeys = new bytes16[](outputs.length);
        for (uint256 i = 0; i < outputs.length; i++) {
            if (!outputs[i].isValid) revert InvalidProof();
            require(outputs[i].oldDataHash == _dataHashes[_tokenId][i], "oldHash");
            require(outputs[i].receiver == _to, "receiver");
            newHashes[i] = outputs[i].newDataHash;
            sealedKeys[i] = outputs[i].sealedKey;
        }

        bytes32[] memory oldHashes = _dataHashes[_tokenId];
        _dataHashes[_tokenId] = newHashes;

        // Clear authorizations on transfer.
        address[] memory cleared = _authorized[_tokenId];
        for (uint256 i = 0; i < cleared.length; i++) {
            _authorizedSet[_tokenId][cleared[i]] = false;
        }
        delete _authorized[_tokenId];

        address from = ownerOf(_tokenId);
        _transfer(from, _to, _tokenId);
        emit Transferred(_tokenId, from, _to);
        emit Updated(_tokenId, oldHashes, newHashes);
        emit PublishedSealedKey(_to, _tokenId, sealedKeys);
    }

    function clone(
        address _to,
        uint256 _tokenId,
        bytes[] calldata _proofs
    ) external returns (uint256 newTokenId) {
        if (msg.sender != ownerOf(_tokenId)) revert NotOwnerOrAuthorized();

        TransferValidityProofOutput[] memory outputs = _verifyTransferValidity(_proofs);
        require(outputs.length == _dataHashes[_tokenId].length, "len");

        bytes32[] memory newHashes = new bytes32[](outputs.length);
        bytes16[] memory sealedKeys = new bytes16[](outputs.length);
        for (uint256 i = 0; i < outputs.length; i++) {
            if (!outputs[i].isValid) revert InvalidProof();
            require(outputs[i].oldDataHash == _dataHashes[_tokenId][i], "oldHash");
            require(outputs[i].receiver == _to, "receiver");
            newHashes[i] = outputs[i].newDataHash;
            sealedKeys[i] = outputs[i].sealedKey;
        }

        newTokenId = ++_nextTokenId;
        _safeMint(_to, newTokenId);
        _dataHashes[newTokenId] = newHashes;
        _dataDescriptions[newTokenId] = _dataDescriptions[_tokenId];

        // Clone the Pulse binding + commitment history so the new owner
        // inherits the full provenance trail.
        pulseBinding[newTokenId] = pulseBinding[_tokenId];
        CommitmentRef[] storage src = _commitments[_tokenId];
        for (uint256 i = 0; i < src.length; i++) {
            _commitments[newTokenId].push(src[i]);
        }

        emit Cloned(_tokenId, newTokenId, msg.sender, _to);
        emit PublishedSealedKey(_to, newTokenId, sealedKeys);
    }

    function authorizeUsage(uint256 _tokenId, address _user) external {
        if (msg.sender != ownerOf(_tokenId)) revert NotOwnerOrAuthorized();
        if (_authorizedSet[_tokenId][_user]) return;
        _authorized[_tokenId].push(_user);
        _authorizedSet[_tokenId][_user] = true;
        emit Authorization(msg.sender, _user, _tokenId);
    }

    function ownerOf(uint256 _tokenId) public view override(ERC721, IERC7857) returns (address) {
        return ERC721.ownerOf(_tokenId);
    }

    function authorizedUsersOf(uint256 _tokenId) external view returns (address[] memory) {
        return _authorized[_tokenId];
    }

    // ────────────────────────────────────────────────────────────────
    // ERC-7857 metadata
    // ────────────────────────────────────────────────────────────────

    function update(uint256 _tokenId, bytes[] calldata _proofs) external {
        if (msg.sender != ownerOf(_tokenId)) revert NotOwnerOrAuthorized();

        PreimageProofOutput[] memory outputs = _verifyPreimage(_proofs);
        bytes32[] memory hashes = new bytes32[](outputs.length);
        for (uint256 i = 0; i < outputs.length; i++) {
            if (!outputs[i].isValid) revert InvalidProof();
            hashes[i] = outputs[i].dataHash;
        }

        bytes32[] memory oldHashes = _dataHashes[_tokenId];
        _dataHashes[_tokenId] = hashes;
        emit Updated(_tokenId, oldHashes, hashes);
    }

    function dataHashesOf(uint256 _tokenId) external view returns (bytes32[] memory) {
        return _dataHashes[_tokenId];
    }

    function dataDescriptionsOf(uint256 _tokenId) external view returns (string[] memory) {
        return _dataDescriptions[_tokenId];
    }

    function name() public view override(ERC721, IERC7857Metadata) returns (string memory) {
        return ERC721.name();
    }

    function symbol() public view override(ERC721, IERC7857Metadata) returns (string memory) {
        return ERC721.symbol();
    }

    function tokenURI(
        uint256 _tokenId
    ) public view override(ERC721, IERC7857Metadata) returns (string memory) {
        _requireOwned(_tokenId);
        // Off-chain readers reconstruct the URI from dataHashes[0] (the ciphertext root
        // hash on 0G Storage). We surface the hash directly for the simplest possible
        // resolver. A richer JSON metadata layer can be added later by overriding.
        bytes32[] memory h = _dataHashes[_tokenId];
        if (h.length == 0) return "";
        return string.concat("og-storage://", Strings.toHexString(uint256(h[0]), 32));
    }

    // ────────────────────────────────────────────────────────────────
    // ERC-7857 verifier (self-verifier — single-contract deployment)
    // ────────────────────────────────────────────────────────────────

    function verifyPreimage(
        bytes[] calldata _proofs
    ) external returns (PreimageProofOutput[] memory) {
        return _verifyPreimage(_proofs);
    }

    function verifyTransferValidity(
        bytes[] calldata _proofs
    ) external returns (TransferValidityProofOutput[] memory) {
        return _verifyTransferValidity(_proofs);
    }

    function _verifyPreimage(
        bytes[] calldata _proofs
    ) internal view returns (PreimageProofOutput[] memory out) {
        out = new PreimageProofOutput[](_proofs.length);
        for (uint256 i = 0; i < _proofs.length; i++) {
            (bytes32 dataHash, bytes memory sig) = abi.decode(_proofs[i], (bytes32, bytes));
            bytes32 digest = keccak256(abi.encode(address(this), "preimage", dataHash))
                .toEthSignedMessageHash();
            address recovered = digest.recover(sig);
            out[i] = PreimageProofOutput({
                dataHash: dataHash,
                isValid: recovered == signerProvider
            });
        }
    }

    function _verifyTransferValidity(
        bytes[] calldata _proofs
    ) internal view returns (TransferValidityProofOutput[] memory out) {
        out = new TransferValidityProofOutput[](_proofs.length);
        for (uint256 i = 0; i < _proofs.length; i++) {
            (
                bytes32 oldDataHash,
                bytes32 newDataHash,
                address receiver,
                bytes16 sealedKey,
                bytes memory sig
            ) = abi.decode(_proofs[i], (bytes32, bytes32, address, bytes16, bytes));
            bytes32 digest = keccak256(
                abi.encode(address(this), "transfer", oldDataHash, newDataHash, receiver, sealedKey)
            ).toEthSignedMessageHash();
            address recovered = digest.recover(sig);
            out[i] = TransferValidityProofOutput({
                oldDataHash: oldDataHash,
                newDataHash: newDataHash,
                receiver: receiver,
                sealedKey: sealedKey,
                isValid: recovered == signerProvider
            });
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Pulse-specific extensions
    // ────────────────────────────────────────────────────────────────

    function bindPulseAgent(
        uint256 _tokenId,
        uint256 _agentId,
        bytes32 _ensNode,
        address _pulse,
        uint256 _pulseChainId
    ) external {
        if (msg.sender != ownerOf(_tokenId)) revert NotOwnerOrAuthorized();
        pulseBinding[_tokenId] = PulseBinding({
            agentId: _agentId,
            ensNode: _ensNode,
            pulse: _pulse,
            pulseChainId: _pulseChainId
        });
        emit PulseBound(_tokenId, _agentId, _ensNode, _pulse, _pulseChainId);
    }

    function recordCommitment(
        uint256 _tokenId,
        uint256 _commitmentId,
        uint256 _pulseChainId
    ) external {
        if (msg.sender != ownerOf(_tokenId)) revert NotOwnerOrAuthorized();
        _commitments[_tokenId].push(
            CommitmentRef({
                commitmentId: _commitmentId,
                pulseChainId: _pulseChainId,
                recordedAt: uint64(block.timestamp)
            })
        );
        emit CommitmentRecorded(_tokenId, _commitmentId, _pulseChainId, _commitments[_tokenId].length);
    }

    function commitmentsOf(uint256 _tokenId) external view returns (CommitmentRef[] memory) {
        return _commitments[_tokenId];
    }

    // ────────────────────────────────────────────────────────────────
    // Admin
    // ────────────────────────────────────────────────────────────────

    function setSignerProvider(address _newSigner) external onlyOwner {
        require(_newSigner != address(0), "signer=0");
        emit SignerProviderUpdated(signerProvider, _newSigner);
        signerProvider = _newSigner;
    }

    function totalSupply() external view returns (uint256) {
        return _nextTokenId;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual override(ERC721) returns (bool) {
        return
            interfaceId == type(IERC7857).interfaceId ||
            interfaceId == type(IERC7857Metadata).interfaceId ||
            interfaceId == type(IERC7857DataVerifier).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
