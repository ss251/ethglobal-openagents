// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

struct PreimageProofOutput {
    bytes32 dataHash;
    bool isValid;
}

struct TransferValidityProofOutput {
    bytes32 oldDataHash;
    bytes32 newDataHash;
    address receiver;
    bytes16 sealedKey;
    bool isValid;
}

// ERC-7857 verifier interface (TEE or ZKP). Vendored verbatim from
// 0glabs/0g-agent-nft (eip-7857-draft branch). Implementations swap out
// without touching the core iNFT contract.
interface IERC7857DataVerifier {
    function verifyPreimage(
        bytes[] calldata _proofs
    ) external returns (PreimageProofOutput[] memory);

    function verifyTransferValidity(
        bytes[] calldata _proofs
    ) external returns (TransferValidityProofOutput[] memory);
}
