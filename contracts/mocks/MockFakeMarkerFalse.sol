// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Mimics the Compound V2 "marker method" pattern (isComptroller / isInterestRateModel)
///      but reports false, used only to test CToken's _setComptroller / _setInterestRateModel
///      marker-check rejection paths.
contract MockFakeMarkerFalse {
    bool public constant isComptroller = false;
    bool public constant isInterestRateModel = false;
}
