// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Stand-in for the `cTokenCollateral` argument CToken.liquidateBorrowFresh calls out to.
/// Deliberately does NOT inherit CTokenInterface -- CToken.sol dispatches to it purely by selector
/// (accrueInterest(), accrualBlockNumber(), balanceOf(address), seize(address,address,uint256)), so
/// only those four functions need to exist with matching signatures.
contract MockLiquidationCollateral {
    address public immutable deployer;
    uint256 public nextAccrueInterestResult;
    uint256 public accrualBlockNumberValue;
    uint256 public nextSeizeResult;
    mapping(address => uint256) public balanceOf;

    constructor() {
        deployer = msg.sender;
    }

    modifier onlyDeployer() {
        require(msg.sender == deployer, "only deployer");
        _;
    }

    function setAccrueInterestResult(uint256 code) external onlyDeployer {
        nextAccrueInterestResult = code;
    }

    function setAccrualBlockNumber(uint256 blockNumber_) external onlyDeployer {
        accrualBlockNumberValue = blockNumber_;
    }

    function setSeizeResult(uint256 code) external onlyDeployer {
        nextSeizeResult = code;
    }

    function setBalance(address account, uint256 balance) external onlyDeployer {
        balanceOf[account] = balance;
    }

    function accrueInterest() external view returns (uint256) {
        return nextAccrueInterestResult;
    }

    function accrualBlockNumber() external view returns (uint256) {
        return accrualBlockNumberValue;
    }

    function seize(address, address, uint256) external view returns (uint256) {
        return nextSeizeResult;
    }
}
