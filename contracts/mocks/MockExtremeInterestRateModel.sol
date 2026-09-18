// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {InterestRateModel} from "../core/InterestRateModel.sol";

/// @dev Returns a configurable, deliberately absurd borrow rate so CToken.accrueInterest's own
/// sanity check (`borrowRateMantissa <= borrowRateMaxMantissa`) can be exercised on its revert path.
contract MockExtremeInterestRateModel is InterestRateModel {
    uint256 public borrowRate;

    constructor(uint256 borrowRate_) {
        borrowRate = borrowRate_;
    }

    function getBorrowRate(uint256, uint256, uint256) external view override returns (uint256) {
        return borrowRate;
    }

    function getSupplyRate(uint256, uint256, uint256, uint256) external pure override returns (uint256) {
        return 0;
    }
}
