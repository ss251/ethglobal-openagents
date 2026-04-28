// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";

import {Pulse} from "../Pulse.sol";

/// @title PulseGatedHook
/// @notice A Uniswap v4 hook that only permits swaps backed by a Pulse commitment.
///         The swapper passes `(commitmentId, nonce)` in `hookData`. The hook either
///         atomically calls `Pulse.reveal` (when status is Pending) or verifies a
///         pre-existing reveal matches the swap params (when status is Revealed).
///         Any other status — Violated, Expired, missing — reverts the swap.
/// @dev Permission set: beforeSwap only. No return-delta — this hook never claims
///      the swap. Adheres to the v4-security-foundations checklist:
///      - msg.sender check is enforced by BaseHook's onlyPoolManager
///      - no NoOp attack surface (beforeSwapReturnDelta is false)
///      - external call to Pulse.reveal is the last action before returning the
///        selector, and Pulse itself is ReentrancyGuard'd
contract PulseGatedHook is BaseHook {
    Pulse public immutable pulse;

    error MalformedHookData();
    error CommitmentMissing();
    error CommitmentExpired();
    error CommitmentNotUsable(Pulse.Status status);
    error IntentMismatch();

    event SwapGated(
        uint256 indexed commitmentId,
        uint256 indexed agentId,
        address indexed swapper,
        bool atomicallyRevealed
    );

    constructor(IPoolManager _poolManager, Pulse _pulse) BaseHook(_poolManager) {
        pulse = _pulse;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @dev hookData = abi.encode(uint256 commitmentId, bytes32 nonce)
    ///      The committed `intentHash` MUST equal
    ///      keccak256(abi.encodePacked(nonce, abi.encode(key, params))).
    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) internal override returns (bytes4, BeforeSwapDelta, uint24) {
        if (hookData.length < 64) revert MalformedHookData();
        (uint256 commitmentId, bytes32 nonce) = abi.decode(hookData, (uint256, bytes32));
        if (commitmentId == 0) revert CommitmentMissing();

        Pulse.Commitment memory c = pulse.getCommitment(commitmentId);
        if (c.principal == address(0)) revert CommitmentMissing();
        if (block.timestamp >= c.revealDeadline) revert CommitmentExpired();

        bytes memory actionData = abi.encode(key, params);
        bool atomicallyRevealed;

        if (c.status == Pulse.Status.Pending) {
            // Pulse.reveal validates window + hash + transitions status atomically.
            // It returns false on intent mismatch and self-marks the commitment Violated.
            bool kept = pulse.reveal(commitmentId, nonce, actionData);
            if (!kept) revert IntentMismatch();
            atomicallyRevealed = true;
        } else if (c.status == Pulse.Status.Revealed) {
            // Already revealed via a separate Pulse.reveal call; verify match.
            bytes32 computed = keccak256(abi.encodePacked(nonce, actionData));
            if (computed != c.intentHash) revert IntentMismatch();
        } else {
            revert CommitmentNotUsable(c.status);
        }

        emit SwapGated(commitmentId, c.agentId, sender, atomicallyRevealed);

        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
}
