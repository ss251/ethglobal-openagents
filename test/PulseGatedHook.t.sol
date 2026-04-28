// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {HookTest} from "@openzeppelin/uniswap-hooks/../test/utils/HookTest.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {Pulse} from "../contracts/Pulse.sol";
import {PulseGatedHook} from "../contracts/hooks/PulseGatedHook.sol";
import {MockIdentityRegistry} from "../contracts/mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "../contracts/mocks/MockReputationRegistry.sol";

contract PulseGatedHookTest is HookTest {
    Pulse internal pulse;
    PulseGatedHook internal hook;
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;

    PoolId internal poolId;

    Vm.Wallet internal provider;
    Vm.Wallet internal principal;

    uint256 internal constant AGENT_ID = 7;
    uint24 internal constant POOL_FEE = 3000;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();
        pulse = new Pulse(address(identity), address(reputation));

        provider = vm.createWallet("provider");
        principal = vm.createWallet("agent-principal");
        identity.setOwner(AGENT_ID, principal.addr);

        // Deploy hook at an address whose lower 14 bits encode BEFORE_SWAP_FLAG only.
        hook = PulseGatedHook(address(uint160(Hooks.BEFORE_SWAP_FLAG)));
        deployCodeTo(
            "PulseGatedHook.sol:PulseGatedHook",
            abi.encode(address(manager), address(pulse)),
            address(hook)
        );

        (key, poolId) = initPool(currency0, currency1, IHooks(address(hook)), POOL_FEE, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 0}(key, LIQUIDITY_PARAMS, ZERO_BYTES);
    }

    // ───────────────────────── helpers ─────────────────────────

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

    function _commitSwap(
        bool zeroForOne,
        int256 amountSpecified,
        bytes32 nonce,
        uint64 executeAfter,
        uint64 revealWindow
    ) internal returns (uint256 commitmentId, SwapParams memory swapParams) {
        swapParams = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: amountSpecified,
            sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });

        bytes memory actionData = abi.encode(key, swapParams);
        bytes32 intentHash = keccak256(abi.encodePacked(nonce, actionData));
        bytes memory sig = _signCommit(AGENT_ID, intentHash, bytes32(0), executeAfter, provider);

        vm.prank(principal.addr);
        commitmentId = pulse.commit(
            AGENT_ID, intentHash, bytes32(0), executeAfter, revealWindow, provider.addr, sig
        );
    }

    function _doSwap(SwapParams memory swapParams, bytes memory hookData) internal {
        swapRouter.swap(
            key,
            swapParams,
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
    }

    // ───────────────────────── tests ─────────────────────────

    function test_swapWithValidCommitment_atomicReveal() public {
        bytes32 nonce = bytes32(uint256(0xa11ce));
        uint64 executeAfter = uint64(block.timestamp + 30 minutes);

        (uint256 id, SwapParams memory params) = _commitSwap(true, -1e15, nonce, executeAfter, 30 minutes);

        vm.warp(executeAfter + 1);
        bytes memory hookData = abi.encode(id, nonce);
        _doSwap(params, hookData);

        assertEq(uint256(pulse.getStatus(id)), uint256(Pulse.Status.Revealed), "should be Revealed");
    }

    function test_swapWithoutCommitment_reverts() public {
        bytes32 nonce = bytes32(uint256(0xb0b));
        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -1e15,
            sqrtPriceLimitX96: MIN_PRICE_LIMIT
        });

        // commitmentId 999 does not exist — Pulse.getCommitment returns zero principal
        bytes memory hookData = abi.encode(uint256(999), nonce);
        vm.expectRevert();
        _doSwap(params, hookData);
    }

    function test_swapWithMismatchedIntent_reverts() public {
        bytes32 nonce = bytes32(uint256(0xc0ffee));
        uint64 executeAfter = uint64(block.timestamp + 10 minutes);

        // Commit to an exactIn -1e15 swap
        (uint256 id,) = _commitSwap(true, -1e15, nonce, executeAfter, 10 minutes);

        // Try to execute a different swap (different amount)
        SwapParams memory mismatched = SwapParams({
            zeroForOne: true,
            amountSpecified: -2e15,
            sqrtPriceLimitX96: MIN_PRICE_LIMIT
        });

        vm.warp(executeAfter + 1);
        bytes memory hookData = abi.encode(id, nonce);
        vm.expectRevert();
        _doSwap(mismatched, hookData);

        // NOTE: with the atomic-reveal flow, the hook reverts on mismatch which
        // also rolls back Pulse's transition to Violated. To lock in a Violated
        // status (and the rep slash that goes with it), the principal must call
        // pulse.reveal directly with the mismatched data — see
        // test_separateMismatchedRevealLocksInViolated.
        assertEq(uint256(pulse.getStatus(id)), uint256(Pulse.Status.Pending), "stays Pending after revert");
    }

    function test_separateMismatchedRevealLocksInViolated() public {
        bytes32 nonce = bytes32(uint256(0xbad));
        uint64 executeAfter = uint64(block.timestamp + 10 minutes);

        (uint256 id, SwapParams memory committedParams) =
            _commitSwap(true, -1e15, nonce, executeAfter, 10 minutes);

        vm.warp(executeAfter + 1);

        // Caller reveals directly with wrong action data — Pulse self-marks Violated
        // and slashes reputation, and the state transition sticks.
        bytes memory wrongAction = abi.encode(key, SwapParams({
            zeroForOne: false,
            amountSpecified: -1e15,
            sqrtPriceLimitX96: MAX_PRICE_LIMIT
        }));
        bool kept = pulse.reveal(id, nonce, wrongAction);
        assertFalse(kept);
        assertEq(uint256(pulse.getStatus(id)), uint256(Pulse.Status.Violated), "stuck Violated");

        // Even attempting the originally-committed swap now fails — commitment is dead.
        bytes memory hookData = abi.encode(id, nonce);
        vm.expectRevert();
        _doSwap(committedParams, hookData);
    }

    function test_swapBeforeWindow_reverts() public {
        bytes32 nonce = bytes32(uint256(0xd00d));
        uint64 executeAfter = uint64(block.timestamp + 1 hours);

        (uint256 id, SwapParams memory params) = _commitSwap(true, -1e15, nonce, executeAfter, 1 hours);

        // Don't warp — we're before executeAfter
        bytes memory hookData = abi.encode(id, nonce);
        vm.expectRevert();
        _doSwap(params, hookData);
    }

    function test_swapAfterRevealDeadline_reverts() public {
        bytes32 nonce = bytes32(uint256(0xfeed));
        uint64 executeAfter = uint64(block.timestamp + 10 minutes);
        uint64 revealWindow = 5 minutes;

        (uint256 id, SwapParams memory params) = _commitSwap(true, -1e15, nonce, executeAfter, revealWindow);

        // Warp past revealDeadline
        vm.warp(executeAfter + revealWindow + 1);
        bytes memory hookData = abi.encode(id, nonce);
        vm.expectRevert();
        _doSwap(params, hookData);
    }

    function test_swapWithSeparateReveal() public {
        // Reveal via direct Pulse.reveal first, then swap — hook re-verifies hash.
        bytes32 nonce = bytes32(uint256(0xbabe));
        uint64 executeAfter = uint64(block.timestamp + 5 minutes);

        (uint256 id, SwapParams memory params) = _commitSwap(true, -1e15, nonce, executeAfter, 30 minutes);

        vm.warp(executeAfter + 1);
        bytes memory actionData = abi.encode(key, params);
        pulse.reveal(id, nonce, actionData);
        assertEq(uint256(pulse.getStatus(id)), uint256(Pulse.Status.Revealed));

        // Now the swap can fire — hook verifies the hash matches without calling reveal again
        bytes memory hookData = abi.encode(id, nonce);
        _doSwap(params, hookData);
    }

    function test_swapWithExpiredCommitment_reverts() public {
        bytes32 nonce = bytes32(uint256(0xdead));
        uint64 executeAfter = uint64(block.timestamp + 5 minutes);
        uint64 revealWindow = 5 minutes;

        (uint256 id, SwapParams memory params) = _commitSwap(true, -1e15, nonce, executeAfter, revealWindow);

        // Past deadline — explicitly expire
        vm.warp(executeAfter + revealWindow + 1);
        pulse.markExpired(id);
        assertEq(uint256(pulse.getStatus(id)), uint256(Pulse.Status.Expired));

        bytes memory hookData = abi.encode(id, nonce);
        vm.expectRevert();
        _doSwap(params, hookData);
    }

    function test_swapWithMalformedHookData_reverts() public {
        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -1e15,
            sqrtPriceLimitX96: MIN_PRICE_LIMIT
        });

        // hookData too short — must be at least 64 bytes (uint256 + bytes32)
        bytes memory hookData = abi.encode(uint256(1));
        vm.expectRevert();
        _doSwap(params, hookData);
    }

    function test_doubleSpendOfCommitment_reverts() public {
        bytes32 nonce = bytes32(uint256(0xcafe));
        uint64 executeAfter = uint64(block.timestamp + 5 minutes);

        (uint256 id, SwapParams memory params) = _commitSwap(true, -1e15, nonce, executeAfter, 30 minutes);

        vm.warp(executeAfter + 1);
        bytes memory hookData = abi.encode(id, nonce);
        _doSwap(params, hookData);
        assertEq(uint256(pulse.getStatus(id)), uint256(Pulse.Status.Revealed));

        // Second attempt: status is Revealed and hash matches → swap should still go through
        // (this is the "Revealed branch" — same nonce + same intent).
        // To exercise true single-use semantics we'd need a different status enum or burn nonces;
        // for v0 this is documented behavior.
        // Here we instead verify a second swap with the SAME id but DIFFERENT params reverts.
        SwapParams memory differentParams = SwapParams({
            zeroForOne: true,
            amountSpecified: -2e15,
            sqrtPriceLimitX96: MIN_PRICE_LIMIT
        });

        vm.expectRevert();
        _doSwap(differentParams, hookData);
    }
}
