// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPulseGate} from "./PulseGatedGate.sol";

/// @notice Reference consumer #2 for Pulse — an over-collateralized
/// single-pool credit primitive where the **borrow** path is gated on
/// Pulse-tagged ERC-8004 reputation through `IPulseGate.assertGate`. The
/// supply, repay, and liquidate paths stay permissionless: only borrowing
/// trust requires reputation.
///
/// Why a lending pool, specifically: borrowing is the cleanest archetype
/// of "trust granted up front, settled later." Pulse reputation is exactly
/// the kind of signal that should price that trust. The gate replaces the
/// usual KYC / off-chain underwriting / credit score with on-chain agent
/// reputation that's cryptographically attributable to past behaviour.
///
/// Mechanics (deliberately minimal — the point is the gate, not novel
/// lending math):
///   - Two assets fixed at deploy time: a `collateralAsset` and a
///     `debtAsset`, both standard ERC-20.
///   - Price between them is a constant set in the constructor, expressed
///     as `collateralPerDebt1e18` (how many wei of collateral equals 1
///     wei of debt, scaled 1e18). For our deployed pETH/pUSD demo pool
///     initialized at 1:1, set to 1e18.
///   - LTV and liquidation thresholds are basis-points and immutable at
///     deploy time.
///   - No interest accrual, no time-based features. Repaying returns the
///     same principal that was borrowed. Live revenue features can be
///     layered on without changing the gate surface.
///
/// What's intentionally OUT of scope: oracles (use a real one in prod),
/// interest accrual, multi-asset baskets, borrow caps per agent. This
/// contract exists to make the "Pulse rep -> borrow access" pattern as
/// small and fork-able as possible.
///
/// Events form the indexing surface — every supply / withdraw / borrow /
/// repay / liquidate emits with `agentId` indexed where applicable, so a
/// subgraph or any chain indexer can build the full trail.
contract PulseGatedLendingPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Immutable config ────────────────────────────────────────────────
    IERC20 public immutable collateralAsset;
    IERC20 public immutable debtAsset;
    IPulseGate public immutable pulseGate;

    /// @notice Collateral / debt price ratio scaled to 1e18.
    /// `1e18` means 1 unit of collateral is worth 1 unit of debt.
    uint256 public immutable collateralPerDebt1e18;

    /// @notice Borrow ceiling as basis points of collateral value.
    /// e.g. `5000` = 50% LTV.
    uint256 public immutable ltvBps;

    /// @notice Threshold above which a position can be liquidated. Must be
    /// > ltvBps so that healthy borrows aren't immediately seizable.
    /// Liquidation is at *any* LTV >= this number (not just exactly 100%).
    uint256 public immutable liquidationLtvBps;

    uint256 private constant BPS = 10_000;

    // ─── Per-user accounting ─────────────────────────────────────────────
    mapping(address => uint256) public collateralOf;
    mapping(address => uint256) public debtOf;

    /// @notice Most recent agentId the borrower attested as. Stored only
    /// so events / off-chain readers can correlate the position with the
    /// ERC-8004 entry that was rep-gated at borrow time.
    mapping(address => uint256) public borrowerAgentId;

    // ─── Events ──────────────────────────────────────────────────────────
    event Supplied(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 indexed agentId, uint256 amount, uint256 newDebt);
    event Repaid(address indexed user, uint256 amount, uint256 newDebt);
    event Liquidated(
        address indexed user,
        address indexed liquidator,
        uint256 indexed agentId,
        uint256 debtRepaid,
        uint256 collateralSeized
    );

    // ─── Errors ──────────────────────────────────────────────────────────
    error ZeroAmount();
    error CannotWithdrawWithDebt();
    error InsufficientCollateral();
    error WouldExceedLTV(uint256 newLtvBps);
    error PositionHealthy(uint256 ltvBps);
    error AmountExceedsDebt();

    constructor(
        address _collateralAsset,
        address _debtAsset,
        address _pulseGate,
        uint256 _collateralPerDebt1e18,
        uint256 _ltvBps,
        uint256 _liquidationLtvBps
    ) {
        require(_collateralAsset != address(0), "collateral=0");
        require(_debtAsset != address(0), "debt=0");
        require(_pulseGate != address(0), "gate=0");
        require(_collateralPerDebt1e18 > 0, "price=0");
        require(_ltvBps > 0 && _ltvBps < _liquidationLtvBps, "ltv");
        require(_liquidationLtvBps <= BPS, "liqLtv");

        collateralAsset = IERC20(_collateralAsset);
        debtAsset = IERC20(_debtAsset);
        pulseGate = IPulseGate(_pulseGate);
        collateralPerDebt1e18 = _collateralPerDebt1e18;
        ltvBps = _ltvBps;
        liquidationLtvBps = _liquidationLtvBps;
    }

    // ─── User actions ────────────────────────────────────────────────────

    /// @notice Supply collateral to the pool.
    function supply(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        collateralOf[msg.sender] += amount;
        collateralAsset.safeTransferFrom(msg.sender, address(this), amount);
        emit Supplied(msg.sender, amount);
    }

    /// @notice Withdraw collateral. Forbidden while debt is outstanding —
    /// real lenders allow partial withdrawals while keeping the LTV
    /// healthy; this keeps the demo small and reasoning-clean.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (debtOf[msg.sender] > 0) revert CannotWithdrawWithDebt();
        if (collateralOf[msg.sender] < amount) revert InsufficientCollateral();
        collateralOf[msg.sender] -= amount;
        collateralAsset.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Borrow `amount` of debt asset against existing collateral.
    /// Requires the caller to hold at least `ltvBps`-worth of collateral
    /// AND for `agentId` to pass the configured Pulse reputation gate.
    /// The gate call is the entire Pulse-specific surface.
    function borrow(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        // Pulse hook: reverts with PulseGatedGate's "insufficient
        // reputation" if the agent is below threshold or untracked.
        pulseGate.assertGate(agentId);

        uint256 newDebt = debtOf[msg.sender] + amount;
        uint256 newLtv = _ltvBpsAt(collateralOf[msg.sender], newDebt);
        if (newLtv > ltvBps) revert WouldExceedLTV(newLtv);

        debtOf[msg.sender] = newDebt;
        borrowerAgentId[msg.sender] = agentId;
        debtAsset.safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, agentId, amount, newDebt);
    }

    /// @notice Repay outstanding debt (no interest in this minimal pool).
    function repay(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 owed = debtOf[msg.sender];
        if (amount > owed) revert AmountExceedsDebt();
        unchecked {
            debtOf[msg.sender] = owed - amount;
        }
        debtAsset.safeTransferFrom(msg.sender, address(this), amount);
        emit Repaid(msg.sender, amount, debtOf[msg.sender]);
    }

    /// @notice Liquidate an unhealthy position. Permissionless — the
    /// liquidator pays off the borrower's debt in full and seizes all
    /// of their collateral (no premium / discount in this minimal pool).
    function liquidate(address user) external nonReentrant {
        uint256 owed = debtOf[user];
        if (owed == 0) revert PositionHealthy(0);
        uint256 ltv = _ltvBpsAt(collateralOf[user], owed);
        if (ltv < liquidationLtvBps) revert PositionHealthy(ltv);

        uint256 seized = collateralOf[user];
        uint256 agentId = borrowerAgentId[user];
        debtOf[user] = 0;
        collateralOf[user] = 0;
        borrowerAgentId[user] = 0;

        debtAsset.safeTransferFrom(msg.sender, address(this), owed);
        collateralAsset.safeTransfer(msg.sender, seized);
        emit Liquidated(user, msg.sender, agentId, owed, seized);
    }

    // ─── Views ───────────────────────────────────────────────────────────

    /// @notice Maximum debt the user could draw given current collateral
    /// and the pool's LTV cap. Returns 0 if they are already at or above.
    function maxBorrow(address user) external view returns (uint256) {
        uint256 ceil = _maxDebtAt(collateralOf[user]);
        uint256 d = debtOf[user];
        return d >= ceil ? 0 : ceil - d;
    }

    /// @notice Current LTV in bps. Returns 0 if no debt.
    function currentLtvBps(address user) external view returns (uint256) {
        if (debtOf[user] == 0) return 0;
        return _ltvBpsAt(collateralOf[user], debtOf[user]);
    }

    function isLiquidatable(address user) external view returns (bool) {
        if (debtOf[user] == 0) return false;
        return _ltvBpsAt(collateralOf[user], debtOf[user]) >= liquidationLtvBps;
    }

    // ─── Internal math ───────────────────────────────────────────────────

    function _maxDebtAt(uint256 collateral) internal view returns (uint256) {
        // collateralValue = collateral * 1e18 / collateralPerDebt1e18
        // maxDebt = collateralValue * ltvBps / BPS
        // Combined to one expression:
        return (collateral * 1e18 * ltvBps) / (collateralPerDebt1e18 * BPS);
    }

    function _ltvBpsAt(uint256 collateral, uint256 debt) internal view returns (uint256) {
        if (collateral == 0) return type(uint256).max;
        // ltvBps = debt * BPS * collateralPerDebt1e18 / (collateral * 1e18)
        return (debt * BPS * collateralPerDebt1e18) / (collateral * 1e18);
    }
}
