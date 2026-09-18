// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20TransferFalse is ERC20 {
    address public immutable deployer;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        deployer = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == deployer, "MockERC20TransferFalse: only deployer");
        _mint(to, amount);
    }

    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }
}
