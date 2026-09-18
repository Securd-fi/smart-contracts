// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PriceOracle} from "./PriceOracle.sol";
import {CToken} from "./CToken.sol";

interface IChainlinkAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface IBandStdReference {
    struct ReferenceData {
        uint256 rate;
        uint256 lastUpdatedBase;
        uint256 lastUpdatedQuote;
    }

    function getReferenceData(string calldata base, string calldata quote)
        external
        view
        returns (ReferenceData memory data);
}

interface ICErc20Underlying {
    function underlying() external view returns (address);
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title SecurdPriceOracle
/// @notice Oracle adapter that supports per-asset Chainlink, Band, or fallback bot pricing.
/// @dev getUnderlyingPrice (the function Comptroller actually consumes) returns prices scaled to
///      10^(36 - underlyingDecimals), matching the raw-balance math in Comptroller's liquidity/liquidation
///      calculations -- see getUnderlyingPrice's own NatSpec for why. previewPrices, by contrast, returns
///      flat 1e18-precision values for off-chain inspection/debugging -- see its NatSpec. A zero return
///      value from either means no valid price is currently available.
/// @dev The external interface matches the core `PriceOracle` abstraction used by the comptroller.
contract SecurdPriceOracle is Ownable, PriceOracle {
    enum OracleType {
        UNSET,
        CHAINLINK,
        BAND,
        FALLBACK
    }

    struct AssetConfig {
        OracleType oracleType;
        address chainlinkFeed;
        uint256 chainlinkHeartbeat;
        string bandBaseSymbol;
        string bandQuoteSymbol;
        uint256 bandMaxDelay;
        uint256 fallbackMaxDelay;
    }

    struct FallbackPrice {
        uint256 priceMantissa;
        uint256 updatedAt;
    }

    error InvalidAsset();
    error InvalidCToken();
    error InvalidBandReference();
    error InvalidOracle();
    error InvalidPrice();
    error InvalidOracleType(uint8 provided);
    error NotAssetOracle(address asset, address caller);
    error MissingChainlinkConfig(address asset);
    error MissingBandConfig(address asset);
    error MissingFallbackConfig(address asset);
    error CircuitBreakerDurationTooLong(uint256 provided, uint256 max);

    event BandReferenceSet(address indexed previous, address indexed current);
    event AssetOracleSet(address indexed asset, address indexed oracle, bool allowed);
    event OracleTypeSet(address indexed asset, OracleType previous, OracleType current);
    event FallbackPricePosted(address indexed asset, uint256 priceMantissa, uint256 updatedAt, address indexed poster);
    event CTokenUnderlyingSet(address indexed cToken, address indexed oldUnderlying, address indexed newUnderlying);
    event AssetConfigSet(address indexed asset);
    event CircuitBreakerActivated(address indexed asset, uint256 expiresAt);
    event CircuitBreakerDeactivated(address indexed asset);

    /// @notice Maximum duration an oracle circuit breaker can be activated for (12 hours).
    uint256 public constant CIRCUIT_BREAKER_MAX_DURATION = 12 hours;

    address public bandStdReference;

    mapping(address => AssetConfig) public assetConfig;
    mapping(address => address) public cTokenUnderlying;
    mapping(address => mapping(address => bool)) public isAssetOracle;
    mapping(address => FallbackPrice) public fallbackPriceOf;

    /// @notice Timestamp until which the circuit breaker is active for a given asset.
    ///         While active, a stale fallback price is served instead of 0, preventing DoS on user positions.
    mapping(address => uint256) public circuitBreakerExpiry;

    /// @param initialOwner Address that receives administrative control.
    /// @param bandStdReference_ Band onchain standard reference contract.
    constructor(address initialOwner, address bandStdReference_) {
        require(initialOwner != address(0), "owner=0");
        if (initialOwner != msg.sender) {
            _transferOwnership(initialOwner);
        }
        bandStdReference = bandStdReference_;
    }

    modifier onlyAssetOracle(address asset) {
        if (!isAssetOracle[asset][msg.sender] && msg.sender != owner()) {
            revert NotAssetOracle(asset, msg.sender);
        }
        _;
    }

    /// @notice Updates the Band reference contract used for Band-priced assets.
    function setBandStdReference(address newBandStdReference) external onlyOwner {
        if (newBandStdReference == address(0)) revert InvalidBandReference();
        address old = bandStdReference;
        bandStdReference = newBandStdReference;
        emit BandReferenceSet(old, newBandStdReference);
    }

    /// @notice Grants or revokes the fallback-price poster role for a specific asset.
    /// @param asset Asset whose bot-poster permission is being updated.
    /// @param oracle Authorized oracle poster address.
    /// @param allowed Whether posting rights are granted.
    function setAssetOracle(address asset, address oracle, bool allowed) external onlyOwner {
        if (asset == address(0)) revert InvalidAsset();
        if (oracle == address(0)) revert InvalidOracle();

        isAssetOracle[asset][oracle] = allowed;
        emit AssetOracleSet(asset, oracle, allowed);
    }

    /// @notice Selects the active oracle source for an asset.
    /// @param asset Asset whose pricing mode is being configured.
    /// @param oracleType Selected oracle mode for the asset.
    function setOracleType(address asset, OracleType oracleType) external onlyOwner {
        if (asset == address(0)) revert InvalidAsset();
        if (oracleType == OracleType.UNSET) revert InvalidOracleType(uint8(oracleType));

        AssetConfig storage cfg = assetConfig[asset];
        if (oracleType == OracleType.CHAINLINK) {
            if (cfg.chainlinkFeed == address(0) || cfg.chainlinkHeartbeat == 0) revert MissingChainlinkConfig(asset);
        } else if (oracleType == OracleType.BAND) {
            if (
                bandStdReference == address(0) || bytes(cfg.bandBaseSymbol).length == 0
                    || bytes(cfg.bandQuoteSymbol).length == 0 || cfg.bandMaxDelay == 0
            ) revert MissingBandConfig(asset);
        } else if (oracleType == OracleType.FALLBACK) {
            if (cfg.fallbackMaxDelay == 0) revert MissingFallbackConfig(asset);
        }

        OracleType previous = cfg.oracleType;
        cfg.oracleType = oracleType;

        emit OracleTypeSet(asset, previous, oracleType);
        emit AssetConfigSet(asset);
    }

    /// @notice Posts a fallback price for assets without dependable onchain feeds, such as XRPL Ledger LP tokens.
    /// @param asset Asset whose fallback price is being updated.
    /// @param priceMantissa Asset price scaled to 1e18.
    function postFallbackPrice(address asset, uint256 priceMantissa) external onlyAssetOracle(asset) {
        if (asset == address(0)) revert InvalidAsset();
        if (priceMantissa == 0) revert InvalidPrice();

        fallbackPriceOf[asset] = FallbackPrice({priceMantissa: priceMantissa, updatedAt: block.timestamp});
        emit FallbackPricePosted(asset, priceMantissa, block.timestamp, msg.sender);
    }

    /// @notice Overrides the underlying asset mapping for a cToken market.
    /// @dev This is useful when a market requires an explicit asset mapping during deployment.
    function setCTokenUnderlying(address cToken, address underlying) external onlyOwner {
        if (cToken == address(0)) revert InvalidCToken();
        if (underlying == address(0)) revert InvalidAsset();

        address old = cTokenUnderlying[cToken];
        cTokenUnderlying[cToken] = underlying;
        emit CTokenUnderlyingSet(cToken, old, underlying);
    }

    /// @notice Sets the freshness window for fallback prices of an asset.
    function setFallbackConfig(address asset, uint256 fallbackMaxDelay) external onlyOwner {
        if (asset == address(0)) revert InvalidAsset();
        require(fallbackMaxDelay > 0, "fallbackDelay=0");

        AssetConfig storage cfg = assetConfig[asset];
        cfg.fallbackMaxDelay = fallbackMaxDelay;
        emit AssetConfigSet(asset);
    }

    /// @notice Sets the Chainlink feed configuration for an asset.
    function setChainlinkConfig(address asset, address chainlinkFeed, uint256 chainlinkHeartbeat) external onlyOwner {
        if (asset == address(0)) revert InvalidAsset();
        require(chainlinkFeed != address(0), "feed=0");
        require(chainlinkHeartbeat > 0, "heartbeat=0");

        AssetConfig storage cfg = assetConfig[asset];
        cfg.chainlinkFeed = chainlinkFeed;
        cfg.chainlinkHeartbeat = chainlinkHeartbeat;
        emit AssetConfigSet(asset);
    }

    /// @notice Sets the Band market symbols and freshness window for an asset.
    function setBandConfig(address asset, string calldata bandBaseSymbol, string calldata bandQuoteSymbol, uint256 bandMaxDelay)
        external
        onlyOwner
    {
        if (asset == address(0)) revert InvalidAsset();
        require(bandStdReference != address(0), "bandRef=0");
        require(bytes(bandBaseSymbol).length > 0, "base=0");
        require(bytes(bandQuoteSymbol).length > 0, "quote=0");
        require(bandMaxDelay > 0, "bandDelay=0");

        AssetConfig storage cfg = assetConfig[asset];
        cfg.bandBaseSymbol = bandBaseSymbol;
        cfg.bandQuoteSymbol = bandQuoteSymbol;
        cfg.bandMaxDelay = bandMaxDelay;

        emit AssetConfigSet(asset);
    }

    /// @notice Activates the circuit breaker for an asset for up to `duration` seconds.
    /// @dev Use when the fallback oracle reporter is down and positions would otherwise be DoS'd.
    ///      While active, _readFallback returns the last cached price regardless of staleness.
    ///      The breaker expires automatically; call deactivateCircuitBreaker to cancel early.
    /// @param asset Asset whose fallback staleness check should be bypassed.
    /// @param duration Seconds from now until the circuit breaker expires (max CIRCUIT_BREAKER_MAX_DURATION).
    function activateCircuitBreaker(address asset, uint256 duration) external onlyOwner {
        if (asset == address(0)) revert InvalidAsset();
        if (duration > CIRCUIT_BREAKER_MAX_DURATION) {
            revert CircuitBreakerDurationTooLong(duration, CIRCUIT_BREAKER_MAX_DURATION);
        }
        uint256 expiresAt = block.timestamp + duration;
        circuitBreakerExpiry[asset] = expiresAt;
        emit CircuitBreakerActivated(asset, expiresAt);
    }

    /// @notice Deactivates the circuit breaker for an asset before its expiry.
    function deactivateCircuitBreaker(address asset) external onlyOwner {
        if (asset == address(0)) revert InvalidAsset();
        circuitBreakerExpiry[asset] = 0;
        emit CircuitBreakerDeactivated(asset);
    }

    /// @notice Returns the currently selected underlying price for a cToken market.
    /// @dev Comptroller's liquidity/liquidation math (getHypotheticalAccountLiquidityInternal,
    ///      liquidateCalculateSeizeTokens) multiplies this price directly against RAW cToken/underlying
    ///      balances with no separate decimals normalization of its own -- this is the classic Compound V2
    ///      contract, which requires the oracle to return price scaled by 10^(36 - underlyingDecimals), not
    ///      a flat 1e18-per-whole-token value. Each _read* helper below returns a flat $-per-whole-token
    ///      price at 1e18 precision (Chainlink/Band's own native convention); _scaleToUnderlyingDecimals
    ///      applies the remaining 10^(18 - underlyingDecimals) factor. Without it, every market whose
    ///      underlying isn't 18 decimals is mispriced (e.g. a 6-decimal asset is undervalued by exactly
    ///      10^12x -- verified empirically before this fix).
    /// @param cToken Market whose underlying asset price is requested.
    /// @return Price scaled to 10^(36 - underlyingDecimals), or zero if unavailable.
    function getUnderlyingPrice(CToken cToken) external view override returns (uint256) {
        address asset = _getUnderlyingAddress(address(cToken));
        return _scaleToUnderlyingDecimals(asset, _readFlatPrice(asset));
    }

    /// @notice Returns all price-source readings for inspection and debugging.
    /// @dev Deliberately NOT decimals-scaled, unlike getUnderlyingPrice -- these are the flat
    ///      $-per-whole-token values as each source natively reports them (Chainlink/Band's own
    ///      convention). This is intentional, not an inconsistency: off-chain consumers (e.g. the LP
    ///      oracle bot in scripts/runXrplLpOracleBot.ts) read component-asset prices from this function
    ///      to compute a pool's dollar value in flat terms, and a Compound-scaled value here would corrupt
    ///      that math for any non-18-decimal component asset. getUnderlyingPrice is the only function
    ///      that applies the underlying-decimals scaling, because it's the only one Comptroller consumes.
    /// @param asset Asset whose configured price sources are queried.
    function previewPrices(address asset)
        external
        view
        returns (
            OracleType oracleType,
            uint256 chainlinkPriceMantissa,
            uint256 bandPriceMantissa,
            uint256 fallbackPriceMantissa,
            uint256 selectedPriceMantissa
        )
    {
        AssetConfig storage cfg = assetConfig[asset];
        oracleType = cfg.oracleType;

        chainlinkPriceMantissa = _readChainlink(cfg);
        bandPriceMantissa = _readBand(cfg);
        fallbackPriceMantissa = _readFallback(asset, cfg);

        if (oracleType == OracleType.CHAINLINK) {
            selectedPriceMantissa = chainlinkPriceMantissa;
        } else if (oracleType == OracleType.BAND) {
            selectedPriceMantissa = bandPriceMantissa;
        } else if (oracleType == OracleType.FALLBACK) {
            selectedPriceMantissa = fallbackPriceMantissa;
        }
    }

    function _readFlatPrice(address asset) internal view returns (uint256) {
        AssetConfig storage cfg = assetConfig[asset];

        if (cfg.oracleType == OracleType.CHAINLINK) {
            return _readChainlink(cfg);
        }

        if (cfg.oracleType == OracleType.BAND) {
            return _readBand(cfg);
        }

        if (cfg.oracleType == OracleType.FALLBACK) {
            return _readFallback(asset, cfg);
        }

        return 0;
    }

    /// @dev Scales a flat $-per-whole-token, 1e18-precision price up/down by the underlying asset's own
    ///      decimals so the result matches what Comptroller's raw-balance math requires (see
    ///      getUnderlyingPrice's NatSpec). Fails safe to 0 (treated as "no valid price" throughout this
    ///      contract) if the asset's decimals() cannot be read, mirroring every other failure path here.
    function _scaleToUnderlyingDecimals(address asset, uint256 flatPriceMantissa) internal view returns (uint256) {
        if (flatPriceMantissa == 0) return 0;
        // A call to an address with no contract code returns success with empty data at the EVM level
        // rather than reverting, and decoding empty data into a uint8 return value is not something
        // try/catch's bare `catch` clause traps -- it propagates as an uncaught panic. Guard explicitly
        // so a misconfigured (non-contract) asset fails safe to 0 like every other path in this contract,
        // instead of reverting the whole read.
        if (asset.code.length == 0) return 0;

        uint8 underlyingDecimals;
        try IERC20Decimals(asset).decimals() returns (uint8 d) {
            underlyingDecimals = d;
        } catch {
            return 0;
        }

        if (underlyingDecimals == 18) return flatPriceMantissa;
        // Guard against pathological >36-decimal tokens overflowing the scaling multiplication.
        if (underlyingDecimals > 36) return 0;
        if (underlyingDecimals < 18) return flatPriceMantissa * (10 ** (18 - underlyingDecimals));
        return flatPriceMantissa / (10 ** (underlyingDecimals - 18));
    }

    function _getUnderlyingAddress(address cToken) internal view returns (address) {
        address configured = cTokenUnderlying[cToken];
        if (configured != address(0)) {
            return configured;
        }

        return ICErc20Underlying(cToken).underlying();
    }

    function _readChainlink(AssetConfig storage cfg) internal view returns (uint256) {
        if (cfg.chainlinkFeed == address(0) || cfg.chainlinkHeartbeat == 0) return 0;

        uint80 roundId;
        int256 answer;
        uint256 updatedAt;
        uint80 answeredInRound;
        try IChainlinkAggregatorV3(cfg.chainlinkFeed).latestRoundData() returns (
            uint80 _roundId, int256 _answer, uint256, uint256 _updatedAt, uint80 _answeredInRound
        ) {
            roundId = _roundId;
            answer = _answer;
            updatedAt = _updatedAt;
            answeredInRound = _answeredInRound;
        } catch {
            return 0;
        }

        // answeredInRound < roundId means the answer comes from a stale round (Chainlink standard check).
        if (answer <= 0 || updatedAt == 0 || answeredInRound < roundId) return 0;
        if (block.timestamp > updatedAt + cfg.chainlinkHeartbeat) return 0;

        uint8 decimals;
        try IChainlinkAggregatorV3(cfg.chainlinkFeed).decimals() returns (uint8 d) {
            decimals = d;
        } catch {
            return 0;
        }

        // Guard against absurdly large exponents that would cause arithmetic overflow.
        if (decimals > 36) return 0;

        uint256 unsignedAnswer = uint256(answer);

        if (decimals == 18) return unsignedAnswer;
        if (decimals < 18) return unsignedAnswer * (10 ** (18 - decimals));
        return unsignedAnswer / (10 ** (decimals - 18));
    }

    function _readBand(AssetConfig storage cfg) internal view returns (uint256) {
        if (bandStdReference == address(0)) return 0;
        if (bytes(cfg.bandBaseSymbol).length == 0 || bytes(cfg.bandQuoteSymbol).length == 0 || cfg.bandMaxDelay == 0) {
            return 0;
        }

        IBandStdReference.ReferenceData memory data;
        try IBandStdReference(bandStdReference).getReferenceData(cfg.bandBaseSymbol, cfg.bandQuoteSymbol) returns (
            IBandStdReference.ReferenceData memory d
        ) {
            data = d;
        } catch {
            return 0;
        }

        if (data.rate == 0 || data.lastUpdatedBase == 0 || data.lastUpdatedQuote == 0) return 0;

        uint256 minUpdated = data.lastUpdatedBase < data.lastUpdatedQuote ? data.lastUpdatedBase : data.lastUpdatedQuote;
        if (block.timestamp > minUpdated + cfg.bandMaxDelay) return 0;

        // Band StdReference returns 1e18-scaled rates.
        return data.rate;
    }

    function _readFallback(address asset, AssetConfig storage cfg) internal view returns (uint256) {
        if (cfg.fallbackMaxDelay == 0) return 0;

        FallbackPrice storage p = fallbackPriceOf[asset];
        if (p.priceMantissa == 0 || p.updatedAt == 0) return 0;

        // Circuit breaker: if active, serve the last cached price to prevent oracle-outage DoS on user positions.
        // Hard cap: even under a circuit breaker, reject prices older than CIRCUIT_BREAKER_MAX_DURATION (12 h).
        // This bounds the maximum stale-price window regardless of how long the breaker remains active.
        uint256 cbExpiry = circuitBreakerExpiry[asset];
        bool circuitBreakerActive = cbExpiry != 0 && block.timestamp <= cbExpiry;

        if (circuitBreakerActive) {
            if (block.timestamp > p.updatedAt + CIRCUIT_BREAKER_MAX_DURATION) return 0;
            return p.priceMantissa;
        }

        if (block.timestamp > p.updatedAt + cfg.fallbackMaxDelay) return 0;
        return p.priceMantissa;
    }
}
