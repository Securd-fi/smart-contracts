// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";

interface IXRPLSecurdBridgeAdapterAdmin {
    function setTrustedGmpSource(string calldata sourceChain, string calldata sourceAddress, bool trusted) external;
    function setTrustedItsSource(string calldata sourceChain, bytes calldata sourceAddress, bool trusted) external;
    function setIntentSigner(bytes32 xrplAccount, address signer) external;
    function trustedGmpSource(bytes32 sourceId) external view returns (bool);
    function trustedItsSource(bytes32 sourceId) external view returns (bool);
    function intentSignerOfXrplAccount(bytes32 xrplAccount) external view returns (address);
    function transferOwnership(address newOwner) external;
}

/// @title XRPLAdapterRegistrarGate
/// @notice Becomes the owner of XRPLSecurdBridgeAdapter so a narrow, low-stakes "registrar" key can
///         onboard new XRPL accounts without ever holding full adapter ownership (pause, market listing,
///         fund withdrawal, nonce reset, ...). The registrar can only grant first-time registration using a
///         single fixed signer address configured by the real owner -- it can never choose an arbitrary
///         signer, revoke an existing registration, or touch anything else on the adapter.
/// @dev All other adapter administration continues to flow through `adminCall`, gated to the owner only, so
///      the owner retains exactly the same control surface as calling the adapter directly today.
contract XRPLAdapterRegistrarGate is Ownable2Step, Pausable {
    IXRPLSecurdBridgeAdapterAdmin public immutable ADAPTER;
    string public constant SOURCE_CHAIN = "xrpl";

    address public registrar;
    address public backendSigner;

    error NotRegistrar();
    error InvalidXrplAddress();
    error InvalidAddress();
    error AdminCallFailed(bytes returnData);

    event RegistrarSet(address indexed previousRegistrar, address indexed newRegistrar);
    event BackendSignerSet(address indexed previousSigner, address indexed newSigner);
    event AccountRegistered(
        bytes32 indexed xrplAccount, string xrplAddress, bool signerSet, bool itsTrustSet, bool gmpTrustSet
    );
    event AdminCallExecuted(address indexed caller, bytes data);

    /// @param initialOwner Cold key / multisig that retains full control through `adminCall`.
    /// @param adapter_ Already-deployed XRPLSecurdBridgeAdapter this gate will administer.
    /// @param registrar_ Initial registrar key (may be address(0) to leave unset until after deployment).
    /// @param backendSigner_ Fixed intent-signer address used for every registration performed via this gate.
    constructor(address initialOwner, address adapter_, address registrar_, address backendSigner_) {
        if (initialOwner == address(0) || adapter_ == address(0) || backendSigner_ == address(0)) {
            revert InvalidAddress();
        }
        if (initialOwner != msg.sender) _transferOwnership(initialOwner);
        ADAPTER = IXRPLSecurdBridgeAdapterAdmin(adapter_);
        registrar = registrar_;
        backendSigner = backendSigner_;
        emit RegistrarSet(address(0), registrar_);
        emit BackendSignerSet(address(0), backendSigner_);
    }

    modifier onlyRegistrar() {
        if (msg.sender != registrar) revert NotRegistrar();
        _;
    }

    // ================= Registrar path (narrow, low-stakes key) =================

    /// @notice Onboards one XRPL account for bridge use: intent signer + ITS trust + GMP trust.
    /// @dev Idempotent and additive only -- each of the three registrations is skipped if already set, and
    ///      none can ever be reverted or reassigned through this function. `backendSigner` is fixed by the
    ///      owner, never chosen by the caller, so a compromised registrar key can only pre-register accounts
    ///      with the legitimate signer; it cannot redirect an account's signed-intent authority anywhere else.
    function registerAccount(string calldata xrplAddress) external onlyRegistrar whenNotPaused {
        _validateXrplAddress(bytes(xrplAddress));

        bytes32 xrplAccount = keccak256(bytes(xrplAddress));
        bytes32 sourceIdIts = keccak256(abi.encode(SOURCE_CHAIN, bytes(xrplAddress)));
        bytes32 sourceIdGmp = keccak256(abi.encode(SOURCE_CHAIN, xrplAddress));

        bool signerSet;
        bool itsSet;
        bool gmpSet;

        if (ADAPTER.intentSignerOfXrplAccount(xrplAccount) == address(0)) {
            ADAPTER.setIntentSigner(xrplAccount, backendSigner);
            signerSet = true;
        }
        if (!ADAPTER.trustedItsSource(sourceIdIts)) {
            ADAPTER.setTrustedItsSource(SOURCE_CHAIN, bytes(xrplAddress), true);
            itsSet = true;
        }
        if (!ADAPTER.trustedGmpSource(sourceIdGmp)) {
            ADAPTER.setTrustedGmpSource(SOURCE_CHAIN, xrplAddress, true);
            gmpSet = true;
        }

        emit AccountRegistered(xrplAccount, xrplAddress, signerSet, itsSet, gmpSet);
    }

    // ================= Owner path (cold key / multisig) =================

    function setRegistrar(address newRegistrar) external onlyOwner {
        emit RegistrarSet(registrar, newRegistrar);
        registrar = newRegistrar;
    }

    function setBackendSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidAddress();
        emit BackendSignerSet(backendSigner, newSigner);
        backendSigner = newSigner;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Forwards any call to the adapter -- setMarket, setEgressGasValue, pause, withdrawNative,
    ///         rescueERC20, resetNonce, setDestinationChain, or any future owner-only adapter function.
    ///         Gives the owner the exact same control over the adapter as calling it directly.
    function adminCall(bytes calldata data) external onlyOwner returns (bytes memory ret) {
        (bool ok, bytes memory out) = address(ADAPTER).call(data);
        if (!ok) revert AdminCallFailed(out);
        emit AdminCallExecuted(msg.sender, data);
        return out;
    }

    /// @notice Hands adapter ownership to `newOwner` directly -- the exit path if this gate is ever retired.
    ///         Two-step on the adapter would be safer, but the adapter itself uses single-step `Ownable`;
    ///         this call takes effect immediately on the adapter side, exactly like calling it directly would.
    function returnAdapterOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        ADAPTER.transferOwnership(newOwner);
    }

    // ================= Internal =================

    /// @dev Classic XRPL address: starts with 'r', 25-35 base58 characters (no 0, O, I, l).
    function _validateXrplAddress(bytes memory a) internal pure {
        uint256 len = a.length;
        if (len < 25 || len > 35 || a[0] != 0x72) revert InvalidXrplAddress();
        for (uint256 i = 0; i < len; i++) {
            bytes1 c = a[i];
            bool isDigit = c >= 0x31 && c <= 0x39; // '1'-'9', no '0'
            bool isUpper = c >= 0x41 && c <= 0x5a && c != 0x49 && c != 0x4f; // A-Z, no I, O
            bool isLower = c >= 0x61 && c <= 0x7a && c != 0x6c; // a-z, no l
            if (!isDigit && !isUpper && !isLower) revert InvalidXrplAddress();
        }
    }
}
