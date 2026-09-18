// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComptrollerInterface} from "../core/ComptrollerInterface.sol";

/// @dev Standalone ComptrollerInterface implementation that allows everything by default (each
/// *Allowed hook returns 0 = NO_ERROR) with every check individually overridable. Used to exercise
/// CToken/CErc20 code paths that a real Comptroller's own policy checks would otherwise always
/// short-circuit before CToken's own sentinel/bounds checks are ever reached (e.g. its own
/// repayAmount == type(uint256).max guard in liquidateBorrowFresh, which the real Comptroller's
/// close-factor bound always rejects first).
contract MockPermissiveComptroller is ComptrollerInterface {
    address public immutable deployer;

    uint256 public nextMintAllowed;
    uint256 public nextRedeemAllowed;
    uint256 public nextBorrowAllowed;
    uint256 public nextRepayBorrowAllowed;
    uint256 public nextLiquidateBorrowAllowed;
    uint256 public nextSeizeAllowed;
    uint256 public nextTransferAllowed;
    uint256 public nextSeizeTokensError;
    uint256 public nextSeizeTokens;

    constructor() {
        deployer = msg.sender;
    }

    modifier onlyDeployer() {
        require(msg.sender == deployer, "only deployer");
        _;
    }

    function setNextMintAllowed(uint256 code) external onlyDeployer { nextMintAllowed = code; }
    function setNextRedeemAllowed(uint256 code) external onlyDeployer { nextRedeemAllowed = code; }
    function setNextBorrowAllowed(uint256 code) external onlyDeployer { nextBorrowAllowed = code; }
    function setNextRepayBorrowAllowed(uint256 code) external onlyDeployer { nextRepayBorrowAllowed = code; }
    function setNextLiquidateBorrowAllowed(uint256 code) external onlyDeployer { nextLiquidateBorrowAllowed = code; }
    function setNextSeizeAllowed(uint256 code) external onlyDeployer { nextSeizeAllowed = code; }
    function setNextTransferAllowed(uint256 code) external onlyDeployer { nextTransferAllowed = code; }
    function setNextSeizeTokensResult(uint256 errorCode, uint256 seizeTokens) external onlyDeployer {
        nextSeizeTokensError = errorCode;
        nextSeizeTokens = seizeTokens;
    }

    function enterMarkets(address[] calldata cTokens) external pure override returns (uint[] memory results) {
        results = new uint[](cTokens.length);
    }

    function exitMarket(address) external pure override returns (uint) {
        return 0;
    }

    function mintAllowed(address, address, uint) external view override returns (uint) { return nextMintAllowed; }
    function mintVerify(address, address, uint, uint) external override {}

    function redeemAllowed(address, address, uint) external view override returns (uint) { return nextRedeemAllowed; }
    function redeemVerify(address, address, uint, uint) external override {}

    function borrowAllowed(address, address, uint) external view override returns (uint) { return nextBorrowAllowed; }
    function borrowVerify(address, address, uint) external override {}

    function repayBorrowAllowed(address, address, address, uint) external view override returns (uint) {
        return nextRepayBorrowAllowed;
    }
    function repayBorrowVerify(address, address, address, uint, uint) external override {}

    function liquidateBorrowAllowed(address, address, address, address, uint) external view override returns (uint) {
        return nextLiquidateBorrowAllowed;
    }
    function liquidateBorrowVerify(address, address, address, address, uint, uint) external override {}

    function seizeAllowed(address, address, address, address, uint) external view override returns (uint) {
        return nextSeizeAllowed;
    }
    function seizeVerify(address, address, address, address, uint) external override {}

    function transferAllowed(address, address, address, uint) external view override returns (uint) {
        return nextTransferAllowed;
    }
    function transferVerify(address, address, address, uint) external override {}

    function liquidateCalculateSeizeTokens(address, address, uint) external view override returns (uint, uint) {
        return (nextSeizeTokensError, nextSeizeTokens);
    }
}
