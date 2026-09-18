// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Minimal ERC20 exposing delegate(address), used only to test CErc20._delegateUnderlyingVotesTo.
contract MockGovernanceToken is ERC20 {
    address public lastDelegatee;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function delegate(address delegatee) external {
        lastDelegatee = delegatee;
    }
}
