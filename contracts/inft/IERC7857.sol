// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import "./IERC7857DataVerifier.sol";

// ERC-7857 — Intelligent NFT (iNFT) interface.
// Vendored verbatim from 0glabs/0g-agent-nft (eip-7857-draft branch) so
// PulseAgentINFT is interchangeable with any other ERC-7857 implementation
// a downstream integrator might already have.
interface IERC7857 {
    /// @dev This emits when a new functional NFT is minted
    event Minted(
        uint256 indexed _tokenId,
        address indexed _creator,
        address indexed _owner,
        bytes32[] _dataHashes,
        string[] _dataDescriptions
    );

    /// @dev This emits when a user is authorized to use the data
    event Authorization(address indexed _from, address indexed _to, uint256 indexed _tokenId);

    /// @dev This emits when data is transferred with ownership
    event Transferred(uint256 _tokenId, address indexed _from, address indexed _to);

    /// @dev This emits when data is cloned
    event Cloned(
        uint256 indexed _tokenId,
        uint256 indexed _newTokenId,
        address _from,
        address _to
    );

    /// @dev This emits when a sealed key is published
    event PublishedSealedKey(
        address indexed _to,
        uint256 indexed _tokenId,
        bytes16[] _sealedKeys
    );

    function verifier() external view returns (IERC7857DataVerifier);

    function mint(
        bytes[] calldata _proofs,
        string[] calldata _dataDescriptions,
        address _to
    ) external payable returns (uint256 _tokenId);

    function transfer(
        address _to,
        uint256 _tokenId,
        bytes[] calldata _proofs
    ) external;

    function clone(
        address _to,
        uint256 _tokenId,
        bytes[] calldata _proofs
    ) external returns (uint256 _newTokenId);

    function authorizeUsage(uint256 _tokenId, address _user) external;

    function ownerOf(uint256 _tokenId) external view returns (address);

    function authorizedUsersOf(uint256 _tokenId) external view returns (address[] memory);
}
