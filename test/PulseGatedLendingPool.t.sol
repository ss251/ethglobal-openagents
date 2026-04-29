// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {PulseGatedLendingPool} from "../contracts/gates/PulseGatedLendingPool.sol";
import {PulseGatedGate} from "../contracts/gates/PulseGatedGate.sol";
import {IReputationRegistry} from "../contracts/interfaces/IReputationRegistry.sol";

/// @notice Standard 18-decimal mock token for the lending pool tests.
/// We deliberately use a different fixture than `MockReputationRegistry`
/// because the pool only cares about `IERC20` semantics.
contract MockToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract PulseGatedLendingPoolTest is Test {
    PulseGatedGate gate;
    PulseGatedLendingPool pool;
    MockToken col; // collateral
    MockToken dbt; // debt

    address constant REGISTRY = address(0xBEEF);
    address constant PULSE = address(0xBE1B);
    address constant OWNER = address(0xA110);

    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    uint256 constant ALICE_AGENT = 100;
    uint256 constant BOB_AGENT = 200;

    int128 constant PASS_SCORE = 80;
    int128 constant FAIL_SCORE = -10;
    int128 constant THRESHOLD = 50;

    // 1 collateral unit = 1 debt unit (matches Pulse's pETH/pUSD demo pool, init at 1:1)
    uint256 constant PRICE_1E18 = 1e18;
    uint256 constant LTV_BPS = 5000; // 50%
    uint256 constant LIQ_BPS = 8500; // 85%

    function setUp() public {
        // Spin the gate that the pool will read.
        vm.prank(OWNER);
        gate = new PulseGatedGate(REGISTRY, PULSE, THRESHOLD, OWNER);

        col = new MockToken("Mock pETH", "pETH");
        dbt = new MockToken("Mock pUSD", "pUSD");

        pool = new PulseGatedLendingPool(
            address(col),
            address(dbt),
            address(gate),
            PRICE_1E18,
            LTV_BPS,
            LIQ_BPS
        );

        // Seed the pool with debt liquidity so borrows can succeed.
        dbt.mint(address(pool), 1_000_000 ether);

        // Each user gets some collateral + (Bob also some debt to repay later).
        col.mint(ALICE, 1_000 ether);
        col.mint(BOB, 1_000 ether);
        dbt.mint(BOB, 1_000 ether);
    }

    // ─── helpers ────────────────────────────────────────────────────────

    function _mockGateScore(uint256 agentId, int128 score, uint64 count) internal {
        address[] memory clients = new address[](1);
        clients[0] = PULSE;
        vm.mockCall(
            REGISTRY,
            abi.encodeWithSelector(IReputationRegistry.getSummary.selector, agentId, clients, "pulse", ""),
            abi.encode(count, score, uint8(0))
        );
    }

    function _supplyAs(address user, uint256 amount) internal {
        vm.startPrank(user);
        col.approve(address(pool), amount);
        pool.supply(amount);
        vm.stopPrank();
    }

    // ─── supply / withdraw ──────────────────────────────────────────────

    function test_supply_increments_collateral() public {
        _supplyAs(ALICE, 100 ether);
        assertEq(pool.collateralOf(ALICE), 100 ether);
        assertEq(col.balanceOf(address(pool)), 100 ether);
    }

    function test_withdraw_returns_collateral_when_no_debt() public {
        _supplyAs(ALICE, 100 ether);
        vm.prank(ALICE);
        pool.withdraw(40 ether);
        assertEq(pool.collateralOf(ALICE), 60 ether);
        assertEq(col.balanceOf(ALICE), 1_000 ether - 60 ether);
    }

    function test_withdraw_reverts_with_outstanding_debt() public {
        _mockGateScore(ALICE_AGENT, PASS_SCORE, 5);
        _supplyAs(ALICE, 100 ether);
        vm.prank(ALICE);
        pool.borrow(ALICE_AGENT, 10 ether);

        vm.expectRevert(PulseGatedLendingPool.CannotWithdrawWithDebt.selector);
        vm.prank(ALICE);
        pool.withdraw(1);
    }

    // ─── borrow gating ──────────────────────────────────────────────────

    function test_borrow_passes_when_pulse_gate_passes() public {
        _mockGateScore(ALICE_AGENT, PASS_SCORE, 5);
        _supplyAs(ALICE, 100 ether);
        vm.prank(ALICE);
        pool.borrow(ALICE_AGENT, 40 ether); // 40% LTV vs 50% cap

        assertEq(pool.debtOf(ALICE), 40 ether);
        assertEq(pool.borrowerAgentId(ALICE), ALICE_AGENT);
        assertEq(dbt.balanceOf(ALICE), 40 ether);
    }

    function test_borrow_reverts_when_pulse_rep_too_low() public {
        _mockGateScore(ALICE_AGENT, FAIL_SCORE, 5);
        _supplyAs(ALICE, 100 ether);
        vm.expectRevert(bytes("PulseGatedGate: insufficient reputation"));
        vm.prank(ALICE);
        pool.borrow(ALICE_AGENT, 40 ether);
    }

    function test_borrow_reverts_when_agent_untracked() public {
        _mockGateScore(ALICE_AGENT, int128(0), uint64(0)); // count=0 ⇒ untracked ⇒ rejected
        _supplyAs(ALICE, 100 ether);
        vm.expectRevert(bytes("PulseGatedGate: insufficient reputation"));
        vm.prank(ALICE);
        pool.borrow(ALICE_AGENT, 40 ether);
    }

    function test_borrow_reverts_when_would_breach_ltv() public {
        _mockGateScore(ALICE_AGENT, PASS_SCORE, 5);
        _supplyAs(ALICE, 100 ether);
        vm.expectRevert(
            abi.encodeWithSelector(PulseGatedLendingPool.WouldExceedLTV.selector, uint256(6000))
        );
        vm.prank(ALICE);
        pool.borrow(ALICE_AGENT, 60 ether); // would be 60% LTV vs 50% cap
    }

    // ─── repay / liquidation ────────────────────────────────────────────

    function test_repay_reduces_debt() public {
        _mockGateScore(ALICE_AGENT, PASS_SCORE, 5);
        _supplyAs(ALICE, 100 ether);
        vm.prank(ALICE);
        pool.borrow(ALICE_AGENT, 40 ether);

        // Alice now needs debt asset to repay; mint some and repay.
        dbt.mint(ALICE, 30 ether);
        vm.startPrank(ALICE);
        dbt.approve(address(pool), 30 ether);
        pool.repay(30 ether);
        vm.stopPrank();

        assertEq(pool.debtOf(ALICE), 10 ether);
    }

    function test_liquidate_reverts_on_healthy_position() public {
        _mockGateScore(ALICE_AGENT, PASS_SCORE, 5);
        _supplyAs(ALICE, 100 ether);
        vm.prank(ALICE);
        pool.borrow(ALICE_AGENT, 40 ether);

        // 40% LTV is well below 85% liquidation threshold
        vm.expectRevert(
            abi.encodeWithSelector(PulseGatedLendingPool.PositionHealthy.selector, uint256(4000))
        );
        vm.prank(BOB);
        pool.liquidate(ALICE);
    }

    function test_liquidate_succeeds_when_unhealthy() public {
        // Set up a healthy position, then push it underwater by bumping
        // debtOf[ALICE] in storage directly. We can't move the price
        // oracle (it's immutable in this minimal pool) and the borrow
        // path enforces LTV ≤ ltvBps, so storage manipulation is the
        // only way to simulate "the market moved against the borrower."
        // In a real lender, an oracle update + interest accrual would
        // produce the same effect.
        _mockGateScore(ALICE_AGENT, PASS_SCORE, 5);
        _supplyAs(ALICE, 100 ether);
        vm.prank(ALICE);
        pool.borrow(ALICE_AGENT, 50 ether); // 50% LTV — exactly at the cap

        // ─── shove the debt into unhealth ──────────────────────────────
        // Storage layout (per `forge inspect storage`):
        //   slot 0 — collateralOf mapping
        //   slot 1 — debtOf mapping
        //   slot 2 — borrowerAgentId mapping
        // To target debtOf[ALICE], hash (ALICE, slot=1):
        bytes32 debtSlot = keccak256(abi.encode(ALICE, uint256(1)));
        // Push debt to 86 ether: LTV becomes 86 / 100 = 8600 bps > 8500 liq.
        vm.store(address(pool), debtSlot, bytes32(uint256(86 ether)));
        assertEq(pool.debtOf(ALICE), 86 ether);
        assertTrue(pool.isLiquidatable(ALICE));

        // Bob, holding 1000 ether of debt asset, liquidates: pays 86,
        // seizes 100. (No premium / discount in this minimal pool — the
        // entire collateral transfers in exchange for clearing the debt.)
        vm.startPrank(BOB);
        dbt.approve(address(pool), 86 ether);

        vm.expectEmit(true, true, true, true, address(pool));
        emit PulseGatedLendingPool.Liquidated(ALICE, BOB, ALICE_AGENT, 86 ether, 100 ether);
        pool.liquidate(ALICE);
        vm.stopPrank();

        assertEq(pool.collateralOf(ALICE), 0);
        assertEq(pool.debtOf(ALICE), 0);
        assertEq(pool.borrowerAgentId(ALICE), 0);
        // Bob started with 1000 ether of collateral asset (from setUp) and seized 100 more.
        assertEq(col.balanceOf(BOB), 1_100 ether);
    }

    // ─── views ──────────────────────────────────────────────────────────

    function test_maxBorrow_reflects_remaining_capacity() public {
        _mockGateScore(ALICE_AGENT, PASS_SCORE, 5);
        _supplyAs(ALICE, 100 ether);
        // Fresh: 100 collateral × 50% LTV / 1.0 price = 50
        assertEq(pool.maxBorrow(ALICE), 50 ether);
        vm.prank(ALICE);
        pool.borrow(ALICE_AGENT, 30 ether);
        assertEq(pool.maxBorrow(ALICE), 20 ether);
    }

    function test_currentLtvBps_zero_without_debt() public {
        _supplyAs(ALICE, 100 ether);
        assertEq(pool.currentLtvBps(ALICE), 0);
    }

    function test_currentLtvBps_reflects_debt_ratio() public {
        _mockGateScore(ALICE_AGENT, PASS_SCORE, 5);
        _supplyAs(ALICE, 100 ether);
        vm.prank(ALICE);
        pool.borrow(ALICE_AGENT, 40 ether);
        assertEq(pool.currentLtvBps(ALICE), 4000);
    }

    // ─── events ─────────────────────────────────────────────────────────

    function test_borrow_emits_with_indexed_agentId() public {
        _mockGateScore(ALICE_AGENT, PASS_SCORE, 5);
        _supplyAs(ALICE, 100 ether);

        vm.expectEmit(true, true, false, true, address(pool));
        emit PulseGatedLendingPool.Borrowed(ALICE, ALICE_AGENT, 40 ether, 40 ether);

        vm.prank(ALICE);
        pool.borrow(ALICE_AGENT, 40 ether);
    }

    // ─── ctor invariants ────────────────────────────────────────────────

    function test_ctor_rejects_invalid_args() public {
        vm.expectRevert(bytes("collateral=0"));
        new PulseGatedLendingPool(
            address(0), address(dbt), address(gate),
            PRICE_1E18, LTV_BPS, LIQ_BPS
        );

        vm.expectRevert(bytes("debt=0"));
        new PulseGatedLendingPool(
            address(col), address(0), address(gate),
            PRICE_1E18, LTV_BPS, LIQ_BPS
        );

        vm.expectRevert(bytes("gate=0"));
        new PulseGatedLendingPool(
            address(col), address(dbt), address(0),
            PRICE_1E18, LTV_BPS, LIQ_BPS
        );

        vm.expectRevert(bytes("price=0"));
        new PulseGatedLendingPool(
            address(col), address(dbt), address(gate),
            0, LTV_BPS, LIQ_BPS
        );

        vm.expectRevert(bytes("ltv"));
        new PulseGatedLendingPool(
            address(col), address(dbt), address(gate),
            PRICE_1E18, 9000, 8000   // ltv must be < liqLtv
        );
    }
}
