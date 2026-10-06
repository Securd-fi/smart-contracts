// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test double with the same admin signatures as Comptroller.sol: bool-returning pause functions and
///      uint256-returning Compound-style admin functions. Return values are set per test.
contract MockTimelockTargetV2 {
    bool public mintPaused;
    uint256 public transferRet;
    uint256 public cfErr;

    function setTransferRet(uint256 v) external {
        transferRet = v;
    }

    function setCfErr(uint256 v) external {
        cfErr = v;
    }

    function _setMintPaused(address, bool state) external returns (bool) {
        mintPaused = state;
        return state;
    }

    function _setTransferPaused(bool) external returns (uint256) {
        return transferRet;
    }

    function _setCollateralFactor(address, uint256) external returns (uint256) {
        return cfErr;
    }
}
