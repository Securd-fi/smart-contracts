// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Underlying token used to exercise CToken's per-function `nonReentrant` guards. During
/// `transferFrom`/`transfer` (the hooks CToken's doTransferIn/doTransferOut call into), it attempts
/// a configurable batch of callbacks into the CToken and swallows their results, so the outer
/// CToken call can still complete normally while each attempted reentry hits its own guard.
contract MockReentrantERC20 is ERC20 {
    address public immutable deployer;
    address[] public reenterTargets;
    bytes[] public reenterCalldatas;
    bool public reenterOnTransferFrom;
    bool public reenterOnTransfer;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        deployer = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setReentryCalls(address[] calldata targets, bytes[] calldata calldatas) external {
        require(msg.sender == deployer, "only deployer");
        require(targets.length == calldatas.length, "length mismatch");
        delete reenterTargets;
        delete reenterCalldatas;
        for (uint256 i = 0; i < targets.length; i++) {
            reenterTargets.push(targets[i]);
            reenterCalldatas.push(calldatas[i]);
        }
    }

    function setReenterOnTransferFrom(bool enabled) external {
        require(msg.sender == deployer, "only deployer");
        reenterOnTransferFrom = enabled;
    }

    function setReenterOnTransfer(bool enabled) external {
        require(msg.sender == deployer, "only deployer");
        reenterOnTransfer = enabled;
    }

    function _attemptReentries() internal {
        uint256 len = reenterTargets.length;
        for (uint256 i = 0; i < len; i++) {
            (bool ok, ) = reenterTargets[i].call(reenterCalldatas[i]);
            ok;
        }
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (reenterOnTransferFrom) {
            _attemptReentries();
        }
        return super.transferFrom(from, to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (reenterOnTransfer) {
            _attemptReentries();
        }
        return super.transfer(to, amount);
    }
}
