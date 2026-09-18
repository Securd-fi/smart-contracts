// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MockChainlinkAggregator {
    uint8 private immutable _decimals;
    address public immutable deployer;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public answeredInRound;
    bool public revertOnDecimals;
    bool public revertOnLatestRoundData;

    constructor(uint8 decimals_) {
        _decimals = decimals_;
        deployer = msg.sender;
    }

    function setRoundData(int256 answer_, uint256 updatedAt_, uint80 answeredInRound_) external {
        require(msg.sender == deployer, "MockChainlinkAggregator: only deployer");
        answer = answer_;
        updatedAt = updatedAt_;
        answeredInRound = answeredInRound_;
    }

    function setRevertOnDecimals(bool shouldRevert) external {
        require(msg.sender == deployer, "MockChainlinkAggregator: only deployer");
        revertOnDecimals = shouldRevert;
    }

    function setRevertOnLatestRoundData(bool shouldRevert) external {
        require(msg.sender == deployer, "MockChainlinkAggregator: only deployer");
        revertOnLatestRoundData = shouldRevert;
    }

    function decimals() external view returns (uint8) {
        require(!revertOnDecimals, "MockChainlinkAggregator: decimals reverted");
        return _decimals;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256, uint256 startedAt, uint256, uint80)
    {
        require(!revertOnLatestRoundData, "MockChainlinkAggregator: latestRoundData reverted");
        return (1, answer, updatedAt, updatedAt, answeredInRound);
    }
}
