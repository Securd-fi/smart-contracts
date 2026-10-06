// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IUnitrollerAdmin {
    function _acceptAdmin() external returns (uint256);
    function admin() external view returns (address);
}

/// @title SecurdCollateralFactorTimelockV2
/// @notice Successor to SecurdCollateralFactorTimelock. Identical governance rules (48-hour minimum for
///         collateral-factor changes, 7-day grace period, owner-only queue/execute/cancel), with one fix:
///         return values are now interpreted per function instead of assuming every 32-byte return is a
///         Compound error code. The original treated `bool true` (1) as a failure, so pause actions such as
///         `_setMintPaused` could never execute through the timelock.
/// @dev Return-value rules:
///      - Compound pause functions (`_setMintPaused`, `_setBorrowPaused`, `_setTransferPaused`,
///        `_setSeizePaused`) return the NEW STATE as a bool. Their success is "the call did not revert and
///        returned a canonical bool", so `false` (an unpause) is a success, not a failure.
///      - Any other call that returns 32 bytes is treated as a uint256 Compound error code (non-zero = failure),
///        matching `_setCollateralFactor` and the other admin functions in Comptroller.sol.
///      - Calls that return no data are accepted (same as before).
contract SecurdCollateralFactorTimelockV2 is Ownable {
    /// @notice Minimum delay enforced for collateral factor changes (48 hours). Not configurable.
    uint256 public constant MIN_DELAY = 48 hours;

    /// @notice Maximum delay that can be set for any queued action (30 days).
    uint256 public constant MAX_DELAY = 30 days;

    /// @notice Grace period after `eta` during which an action can still be executed (7 days).
    uint256 public constant GRACE_PERIOD = 7 days;

    bytes4 private constant SET_COLLATERAL_FACTOR_SELECTOR =
        bytes4(keccak256("_setCollateralFactor(address,uint256)"));
    bytes4 private constant SET_MINT_PAUSED_SELECTOR = bytes4(keccak256("_setMintPaused(address,bool)"));
    bytes4 private constant SET_BORROW_PAUSED_SELECTOR = bytes4(keccak256("_setBorrowPaused(address,bool)"));
    bytes4 private constant SET_TRANSFER_PAUSED_SELECTOR = bytes4(keccak256("_setTransferPaused(bool)"));
    bytes4 private constant SET_SEIZE_PAUSED_SELECTOR = bytes4(keccak256("_setSeizePaused(bool)"));

    struct QueuedAction {
        address target;
        uint256 value;
        bytes data;
        uint256 eta;
        bool exists;
    }

    error ActionNotQueued(bytes32 actionId);
    error ActionAlreadyQueued(bytes32 actionId);
    error ActionNotReady(bytes32 actionId, uint256 eta, uint256 now_);
    error ActionExpired(bytes32 actionId, uint256 eta);
    error DelayTooShort(uint256 provided, uint256 minimum);
    error DelayTooLong(uint256 provided, uint256 maximum);
    error ExecutionFailed(bytes32 actionId, bytes returnData);
    error InvalidTarget();
    error InvalidBoolReturn(bytes32 actionId, bytes returnData);

    event ActionQueued(bytes32 indexed actionId, address indexed target, bytes data, uint256 eta);
    event ActionExecuted(bytes32 indexed actionId, address indexed target, bytes data);
    event ActionCancelled(bytes32 indexed actionId);
    event UnitrollerAdminAccepted(address indexed unitroller);

    mapping(bytes32 => QueuedAction) public queuedActions;

    constructor(address initialOwner) {
        require(initialOwner != address(0), "owner=0");
        if (initialOwner != msg.sender) {
            _transferOwnership(initialOwner);
        }
    }

    /// @notice Completes the Unitroller admin handoff by calling `_acceptAdmin` on the proxy.
    function acceptUnitrollerAdmin(address unitroller) external onlyOwner {
        if (unitroller == address(0)) revert InvalidTarget();
        uint256 err = IUnitrollerAdmin(unitroller)._acceptAdmin();
        require(err == 0, "acceptAdmin failed");
        emit UnitrollerAdminAccepted(unitroller);
    }

    /// @notice Queues an admin call to execute after `delay` seconds.
    /// @dev Collateral-factor changes require `delay >= MIN_DELAY`. Other calls may use `delay = 0`.
    function queue(address target, uint256 value, bytes calldata data, uint256 delay)
        external
        onlyOwner
        returns (bytes32 actionId)
    {
        if (target == address(0)) revert InvalidTarget();
        if (delay > MAX_DELAY) revert DelayTooLong(delay, MAX_DELAY);

        bool isCollateralFactorChange = data.length >= 4 && bytes4(data[:4]) == SET_COLLATERAL_FACTOR_SELECTOR;
        if (isCollateralFactorChange && delay < MIN_DELAY) {
            revert DelayTooShort(delay, MIN_DELAY);
        }

        uint256 eta = block.timestamp + delay;
        actionId = keccak256(abi.encode(target, value, data, eta));

        if (queuedActions[actionId].exists) revert ActionAlreadyQueued(actionId);

        queuedActions[actionId] = QueuedAction({target: target, value: value, data: data, eta: eta, exists: true});

        emit ActionQueued(actionId, target, data, eta);
    }

    /// @notice Executes a queued action once its delay has elapsed and before its grace period ends.
    function execute(bytes32 actionId) external onlyOwner {
        QueuedAction storage action = queuedActions[actionId];
        if (!action.exists) revert ActionNotQueued(actionId);
        if (block.timestamp < action.eta) revert ActionNotReady(actionId, action.eta, block.timestamp);
        if (block.timestamp > action.eta + GRACE_PERIOD) revert ActionExpired(actionId, action.eta);

        address target = action.target;
        uint256 value = action.value;
        bytes memory data = action.data;
        bytes4 selector = data.length >= 4 ? bytes4(data) : bytes4(0);

        delete queuedActions[actionId];

        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert ExecutionFailed(actionId, ret);

        if (_isBoolReturn(selector)) {
            // Must be a canonical ABI bool: exactly 32 bytes whose value is 0 or 1.
            if (ret.length != 32) revert InvalidBoolReturn(actionId, ret);
            uint256 raw = abi.decode(ret, (uint256));
            if (raw > 1) revert InvalidBoolReturn(actionId, ret);
        } else if (ret.length == 32) {
            // Compound-style uint256 error code: non-zero means the admin call failed.
            uint256 errCode = abi.decode(ret, (uint256));
            if (errCode != 0) revert ExecutionFailed(actionId, ret);
        }

        emit ActionExecuted(actionId, target, data);
    }

    /// @notice Cancels a queued action before it is executed.
    function cancel(bytes32 actionId) external onlyOwner {
        if (!queuedActions[actionId].exists) revert ActionNotQueued(actionId);
        delete queuedActions[actionId];
        emit ActionCancelled(actionId);
    }

    function _isBoolReturn(bytes4 selector) internal pure returns (bool) {
        return selector == SET_MINT_PAUSED_SELECTOR
            || selector == SET_BORROW_PAUSED_SELECTOR
            || selector == SET_TRANSFER_PAUSED_SELECTOR
            || selector == SET_SEIZE_PAUSED_SELECTOR;
    }

    receive() external payable {}
}
