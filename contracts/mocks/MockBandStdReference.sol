// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MockBandStdReference {
    struct ReferenceData {
        uint256 rate;
        uint256 lastUpdatedBase;
        uint256 lastUpdatedQuote;
    }

    address public immutable deployer;
    ReferenceData public data;
    bool public revertOnGetReferenceData;

    constructor() {
        deployer = msg.sender;
    }

    function setReferenceData(uint256 rate_, uint256 lastUpdatedBase_, uint256 lastUpdatedQuote_) external {
        require(msg.sender == deployer, "MockBandStdReference: only deployer");
        data = ReferenceData({rate: rate_, lastUpdatedBase: lastUpdatedBase_, lastUpdatedQuote: lastUpdatedQuote_});
    }

    function setRevertOnGetReferenceData(bool shouldRevert) external {
        require(msg.sender == deployer, "MockBandStdReference: only deployer");
        revertOnGetReferenceData = shouldRevert;
    }

    function getReferenceData(string calldata, string calldata) external view returns (ReferenceData memory) {
        require(!revertOnGetReferenceData, "MockBandStdReference: getReferenceData reverted");
        return data;
    }
}
