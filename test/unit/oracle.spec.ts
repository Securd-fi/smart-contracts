// @ts-nocheck
import { expect } from "chai";
import { ethers } from "hardhat";

describe("SecurdPriceOracle", function () {
  it("rejects missing oracle configuration and unauthorized fallback posters", async function () {
    const [owner, outsider] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = ethers.Wallet.createRandom().address;

    await expect(oracle.setOracleType(asset, 1)).to.be.revertedWithCustomError(oracle, "MissingChainlinkConfig");
    await expect(oracle.setOracleType(asset, 2)).to.be.revertedWithCustomError(oracle, "MissingBandConfig");
    await expect(oracle.setOracleType(asset, 3)).to.be.revertedWithCustomError(oracle, "MissingFallbackConfig");

    await oracle.setFallbackConfig(asset, 3600);
    await expect(oracle.connect(outsider).postFallbackPrice(asset, 1n)).to.be.revertedWithCustomError(
      oracle,
      "NotAssetOracle"
    );
  });

  it("reads a Chainlink-configured price", async function () {
    const [owner] = await ethers.getSigners();
    const Band = await ethers.getContractFactory("MockBandStdReference");
    const band = await Band.deploy();
    const Oracle = await ethers.getContractFactory("SecurdPriceOracle");
    const oracle = await Oracle.deploy(owner.address, band.target);
    const Agg = await ethers.getContractFactory("MockChainlinkAggregator");
    const agg = await Agg.deploy(8);
    // Real 18-decimal mock token, not a bare EOA address: getUnderlyingPrice now reads decimals()
    // on the asset to apply the underlying-decimals scaling fix, which needs an actual contract.
    // 18 decimals keeps the scale factor at 1x so every existing assertion below is unchanged.
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);

    const latest = await ethers.provider.getBlock("latest");
    await agg.setRoundData(123456789n, BigInt(latest!.timestamp), 1);
    await oracle.setChainlinkConfig(asset.target, agg.target, 3600);
    await oracle.setOracleType(asset.target, 1);

    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(1234567890000000000n);
  });

  it("returns zero for stale or invalid Chainlink data and rescales decimals above 18", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);
    const agg = await (await ethers.getContractFactory("MockChainlinkAggregator")).deploy(20);
    const latest = await ethers.provider.getBlock("latest");

    await agg.setRoundData(-1n, BigInt(latest!.timestamp), 1);
    await oracle.setChainlinkConfig(asset.target, agg.target, 3600);
    await oracle.setOracleType(asset.target, 1);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);

    await agg.setRoundData(123456789012345678901n, BigInt(latest!.timestamp), 1);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(1234567890123456789n);

    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("returns zero when the Chainlink feed itself reports more than 36 decimals", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);
    // 40 decimals on the feed itself (distinct from the underlying-decimals >36 case elsewhere),
    // guarding against an arithmetic-overflow exponent in the rescale math.
    const agg = await (await ethers.getContractFactory("MockChainlinkAggregator")).deploy(40);
    const latest = await ethers.provider.getBlock("latest");

    await agg.setRoundData(123456789n, BigInt(latest!.timestamp), 1);
    await oracle.setChainlinkConfig(asset.target, agg.target, 3600);
    await oracle.setOracleType(asset.target, 1);

    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("supports per-asset fallback posting and staleness", async function () {
    const [owner, bot] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);

    await oracle.setFallbackConfig(asset.target, 1000);
    await oracle.setAssetOracle(asset.target, bot.address, true);
    await oracle.setOracleType(asset.target, 3);
    await oracle.connect(bot).postFallbackPrice(asset.target, 2n * 10n ** 18n);

    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(2n * 10n ** 18n);

    await ethers.provider.send("evm_increaseTime", [1001]);
    await ethers.provider.send("evm_mine", []);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("reads Band prices when configured", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);
    const latest = await ethers.provider.getBlock("latest");

    await band.setReferenceData(5n * 10n ** 18n, BigInt(latest!.timestamp), BigInt(latest!.timestamp));
    await oracle.setBandConfig(asset.target, "XRP", "USD", 3600);
    await oracle.setOracleType(asset.target, 2);

    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(5n * 10n ** 18n);
  });

  it("circuit breaker bypasses fallback staleness during the grace window and expires automatically", async function () {
    const [owner, bot] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);
    const DELAY = 60; // 60-second fallback window

    await oracle.setFallbackConfig(asset.target, DELAY);
    await oracle.setAssetOracle(asset.target, bot.address, true);
    await oracle.setOracleType(asset.target, 3);
    await oracle.connect(bot).postFallbackPrice(asset.target, 5n * 10n ** 18n);

    // Price is valid
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(5n * 10n ** 18n);

    // Advance past the fallback max delay — price should expire
    await ethers.provider.send("evm_increaseTime", [DELAY + 1]);
    await ethers.provider.send("evm_mine", []);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);

    // Activate circuit breaker for 1 hour
    await oracle.activateCircuitBreaker(asset.target, 3600);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(5n * 10n ** 18n);

    // Advance past circuit breaker expiry — price should expire again
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("circuit breaker can be deactivated early by the owner", async function () {
    const [owner, bot] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);

    await oracle.setFallbackConfig(asset.target, 30);
    await oracle.setAssetOracle(asset.target, bot.address, true);
    await oracle.setOracleType(asset.target, 3);
    await oracle.connect(bot).postFallbackPrice(asset.target, 7n * 10n ** 18n);

    await ethers.provider.send("evm_increaseTime", [31]);
    await ethers.provider.send("evm_mine", []);

    await oracle.activateCircuitBreaker(asset.target, 3600);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(7n * 10n ** 18n);

    await expect(oracle.deactivateCircuitBreaker(asset.target)).to.emit(oracle, "CircuitBreakerDeactivated");
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("circuit breaker's own 12h hard cap still expires a price whose staleness predates activation", async function () {
    const [owner, bot] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);

    await oracle.setFallbackConfig(asset.target, 30);
    await oracle.setAssetOracle(asset.target, bot.address, true);
    await oracle.setOracleType(asset.target, 3);
    await oracle.connect(bot).postFallbackPrice(asset.target, 7n * 10n ** 18n);

    // Let the price go stale well past CIRCUIT_BREAKER_MAX_DURATION (12h) BEFORE the breaker is ever
    // activated, then activate a short (1h) breaker. The breaker is still nominally active, but the
    // hard cap measures staleness from the price's own updatedAt, not from activation time, so it
    // must still expire the price even though circuitBreakerActive is true.
    await ethers.provider.send("evm_increaseTime", [13 * 3600]);
    await ethers.provider.send("evm_mine", []);

    await oracle.activateCircuitBreaker(asset.target, 3600);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("circuit breaker rejects durations above CIRCUIT_BREAKER_MAX_DURATION", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = ethers.Wallet.createRandom().address;
    const MAX = 12 * 3600; // CIRCUIT_BREAKER_MAX_DURATION

    await expect(oracle.activateCircuitBreaker(asset, MAX + 1)).to.be.revertedWithCustomError(
      oracle,
      "CircuitBreakerDurationTooLong"
    );

    // Exactly at max is allowed
    await oracle.setFallbackConfig(asset, 60);
    await oracle.setOracleType(asset, 3);
    await expect(oracle.activateCircuitBreaker(asset, MAX)).to.emit(oracle, "CircuitBreakerActivated");
  });

  it("circuit breaker is only callable by the owner", async function () {
    const [owner, outsider] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = ethers.Wallet.createRandom().address;

    await expect(oracle.connect(outsider).activateCircuitBreaker(asset, 3600)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
    await expect(oracle.connect(outsider).deactivateCircuitBreaker(asset)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
  });

  it("supports configured cToken-underlying overrides and previewing all price sources", async function () {
    const [owner, bot] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const configuredAsset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(
      ethers.Wallet.createRandom().address
    );
    const agg = await (await ethers.getContractFactory("MockChainlinkAggregator")).deploy(8);
    const latest = await ethers.provider.getBlock("latest");

    await oracle.setCTokenUnderlying(cToken.target, configuredAsset.target);
    await agg.setRoundData(2_50000000n, BigInt(latest!.timestamp), 1);
    await oracle.setChainlinkConfig(configuredAsset.target, agg.target, 3600);
    await oracle.setBandConfig(configuredAsset.target, "XRP", "USD", 3600);
    await band.setReferenceData(3n * 10n ** 18n, BigInt(latest!.timestamp), BigInt(latest!.timestamp));
    await oracle.setFallbackConfig(configuredAsset.target, 3600);
    await oracle.setAssetOracle(configuredAsset.target, bot.address, true);
    await oracle.connect(bot).postFallbackPrice(configuredAsset.target, 4n * 10n ** 18n);
    await oracle.setOracleType(configuredAsset.target, 2);

    const preview = await oracle.previewPrices(configuredAsset.target);
    expect(preview.chainlinkPriceMantissa).to.equal(25n * 10n ** 17n);
    expect(preview.bandPriceMantissa).to.equal(3n * 10n ** 18n);
    expect(preview.fallbackPriceMantissa).to.equal(4n * 10n ** 18n);
    expect(preview.selectedPriceMantissa).to.equal(3n * 10n ** 18n);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(3n * 10n ** 18n);
  });

  // Regression coverage for the underlying-decimals scaling fix: Comptroller's liquidity/liquidation
  // math multiplies getUnderlyingPrice's return value directly against RAW cToken/underlying balances
  // with no decimals normalization of its own, so the oracle must scale by 10^(18-underlyingDecimals)
  // on top of each feed's flat $-per-whole-token price. Before this fix, every non-18-decimal market
  // was silently mispriced by exactly that factor (e.g. 6 decimals -> undervalued by 10^12x) -- proven
  // empirically against the real Comptroller before the fix existed; see the end-to-end case in
  // test/integration/comptroller.spec.ts for the full liquidity-math proof.
  it("scales the fallback price by 10^(18-decimals) for a 6-decimal underlying", async function () {
    const [owner, bot] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);

    await oracle.setFallbackConfig(asset.target, 3600);
    await oracle.setAssetOracle(asset.target, bot.address, true);
    await oracle.setOracleType(asset.target, 3);
    // Bot posts the flat $1.00 price exactly as Chainlink/Band would report it -- 1e18, decimals-unaware.
    await oracle.connect(bot).postFallbackPrice(asset.target, 10n ** 18n);

    // 1e18 (flat $1.00) * 10^(18-6) = 1e30
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(10n ** 30n);
  });

  it("scales the Chainlink price by 10^(18-decimals) for an 8-decimal underlying", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Wrapped BTC", "WBTC", 8);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);
    const agg = await (await ethers.getContractFactory("MockChainlinkAggregator")).deploy(8);
    const latest = await ethers.provider.getBlock("latest");

    // Feed reports $77,912 at the feed's own 8 decimals -- _readChainlink already normalizes this to
    // a flat 1e18 ($77912 * 1e18); the fix then applies the underlying's OWN decimals on top.
    await agg.setRoundData(77912_00000000n, BigInt(latest!.timestamp), 1);
    await oracle.setChainlinkConfig(asset.target, agg.target, 3600);
    await oracle.setOracleType(asset.target, 1);

    // flat $77,912 (1e18) * 10^(18-8) = 77912 * 1e28
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(77912n * 10n ** 28n);
  });

  it("divides instead of multiplies for an above-18-decimal underlying", async function () {
    const [owner, bot] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Exotic", "EXO", 24);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);

    await oracle.setFallbackConfig(asset.target, 3600);
    await oracle.setAssetOracle(asset.target, bot.address, true);
    await oracle.setOracleType(asset.target, 3);
    await oracle.connect(bot).postFallbackPrice(asset.target, 10n ** 18n);

    // 1e18 (flat $1.00) / 10^(24-18) = 1e12
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(10n ** 12n);
  });

  it("fails safe to zero when the asset has no contract code at all", async function () {
    const [owner, bot] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = ethers.Wallet.createRandom().address; // deliberately not a deployed contract
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset);

    await oracle.setFallbackConfig(asset, 3600);
    await oracle.setAssetOracle(asset, bot.address, true);
    await oracle.setOracleType(asset, 3);
    await oracle.connect(bot).postFallbackPrice(asset, 10n ** 18n);

    // A price exists, but the "asset" isn't a real ERC20 (no decimals() to read) -- must fail safe to 0
    // rather than revert the whole read, matching every other failure path in this contract.
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("transfers ownership when the initial owner differs from the deployer", async function () {
    const [deployer, owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle"))
      .connect(deployer)
      .deploy(owner.address, band.target);
    expect(await oracle.owner()).to.equal(owner.address);
  });

  it("rejects a zero owner at construction", async function () {
    const Oracle = await ethers.getContractFactory("SecurdPriceOracle");
    await expect(Oracle.deploy(ethers.ZeroAddress, ethers.ZeroAddress)).to.be.revertedWith("owner=0");
  });

  it("updates the Band reference and rejects a zero address", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const newBand = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);

    await expect(oracle.setBandStdReference(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      oracle,
      "InvalidBandReference"
    );
    await expect(oracle.setBandStdReference(newBand.target))
      .to.emit(oracle, "BandReferenceSet")
      .withArgs(band.target, newBand.target);
    expect(await oracle.bandStdReference()).to.equal(newBand.target);
  });

  it("rejects zero-address arguments across every admin setter", async function () {
    const [owner, bot] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = ethers.Wallet.createRandom().address;

    await expect(oracle.setAssetOracle(ethers.ZeroAddress, bot.address, true)).to.be.revertedWithCustomError(
      oracle,
      "InvalidAsset"
    );
    await expect(oracle.setAssetOracle(asset, ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
      oracle,
      "InvalidOracle"
    );

    await expect(oracle.setOracleType(ethers.ZeroAddress, 3)).to.be.revertedWithCustomError(oracle, "InvalidAsset");
    await expect(oracle.setOracleType(asset, 0)).to.be.revertedWithCustomError(oracle, "InvalidOracleType");

    await expect(oracle.postFallbackPrice(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(
      oracle,
      "InvalidAsset"
    );
    await oracle.setFallbackConfig(asset, 3600);
    await oracle.setAssetOracle(asset, owner.address, true);
    await expect(oracle.postFallbackPrice(asset, 0)).to.be.revertedWithCustomError(oracle, "InvalidPrice");

    await expect(oracle.setCTokenUnderlying(ethers.ZeroAddress, asset)).to.be.revertedWithCustomError(
      oracle,
      "InvalidCToken"
    );
    await expect(oracle.setCTokenUnderlying(asset, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      oracle,
      "InvalidAsset"
    );

    await expect(oracle.setFallbackConfig(ethers.ZeroAddress, 3600)).to.be.revertedWithCustomError(
      oracle,
      "InvalidAsset"
    );
    await expect(oracle.setFallbackConfig(asset, 0)).to.be.revertedWith("fallbackDelay=0");

    await expect(
      oracle.setChainlinkConfig(ethers.ZeroAddress, owner.address, 3600)
    ).to.be.revertedWithCustomError(oracle, "InvalidAsset");
    await expect(oracle.setChainlinkConfig(asset, ethers.ZeroAddress, 3600)).to.be.revertedWith("feed=0");
    await expect(oracle.setChainlinkConfig(asset, owner.address, 0)).to.be.revertedWith("heartbeat=0");

    await expect(
      oracle.setBandConfig(ethers.ZeroAddress, "XRP", "USD", 3600)
    ).to.be.revertedWithCustomError(oracle, "InvalidAsset");
    await expect(oracle.setBandConfig(asset, "", "USD", 3600)).to.be.revertedWith("base=0");
    await expect(oracle.setBandConfig(asset, "XRP", "", 3600)).to.be.revertedWith("quote=0");
    await expect(oracle.setBandConfig(asset, "XRP", "USD", 0)).to.be.revertedWith("bandDelay=0");

    const oracleNoBand = await (
      await ethers.getContractFactory("SecurdPriceOracle")
    ).deploy(owner.address, ethers.ZeroAddress);
    await expect(oracleNoBand.setBandConfig(asset, "XRP", "USD", 3600)).to.be.revertedWith("bandRef=0");

    await expect(oracle.activateCircuitBreaker(ethers.ZeroAddress, 60)).to.be.revertedWithCustomError(
      oracle,
      "InvalidAsset"
    );
    await expect(oracle.deactivateCircuitBreaker(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      oracle,
      "InvalidAsset"
    );
  });

  it("returns zero for an asset with no oracle configured at all (UNSET)", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);

    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("fails safe to zero when the Chainlink feed reverts on latestRoundData or decimals", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);
    const agg = await (await ethers.getContractFactory("MockChainlinkAggregator")).deploy(8);
    const latest = await ethers.provider.getBlock("latest");

    await agg.setRoundData(123456789n, BigInt(latest!.timestamp), 1);
    await oracle.setChainlinkConfig(asset.target, agg.target, 3600);
    await oracle.setOracleType(asset.target, 1);

    await agg.setRevertOnLatestRoundData(true);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
    await agg.setRevertOnLatestRoundData(false);

    await agg.setRevertOnDecimals(true);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("fails safe to zero when the Band reference reverts on getReferenceData", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);
    const latest = await ethers.provider.getBlock("latest");

    await band.setReferenceData(5n * 10n ** 18n, BigInt(latest!.timestamp), BigInt(latest!.timestamp));
    await oracle.setBandConfig(asset.target, "XRP", "USD", 3600);
    await oracle.setOracleType(asset.target, 2);

    await band.setRevertOnGetReferenceData(true);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("returns zero for Band data with a zero rate or zero update timestamps", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);
    const latest = await ethers.provider.getBlock("latest");

    await oracle.setBandConfig(asset.target, "XRP", "USD", 3600);
    await oracle.setOracleType(asset.target, 2);

    // rate == 0
    await band.setReferenceData(0n, BigInt(latest!.timestamp), BigInt(latest!.timestamp));
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);

    // lastUpdatedBase == 0
    await band.setReferenceData(5n * 10n ** 18n, 0n, BigInt(latest!.timestamp));
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);

    // lastUpdatedQuote == 0
    await band.setReferenceData(5n * 10n ** 18n, BigInt(latest!.timestamp), 0n);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);

    // stale: older than bandMaxDelay
    await band.setReferenceData(5n * 10n ** 18n, BigInt(latest!.timestamp), BigInt(latest!.timestamp));
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("fails safe to zero when the underlying-decimals lookup target's decimals() reverts", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    // MockChainlinkAggregator conveniently also exposes decimals() with a revert toggle -- reuse it
    // here as a stand-in "asset" instead of adding a near-duplicate mock.
    const asset = await (await ethers.getContractFactory("MockChainlinkAggregator")).deploy(18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);

    await oracle.setFallbackConfig(asset.target, 3600);
    await oracle.setAssetOracle(asset.target, owner.address, true);
    await oracle.setOracleType(asset.target, 3);
    await oracle.postFallbackPrice(asset.target, 10n ** 18n);

    await asset.setRevertOnDecimals(true);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("returns zero for a >36-decimal underlying instead of overflowing the scale factor", async function () {
    const [owner, bot] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockChainlinkAggregator")).deploy(50);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);

    await oracle.setFallbackConfig(asset.target, 3600);
    await oracle.setAssetOracle(asset.target, bot.address, true);
    await oracle.setOracleType(asset.target, 3);
    await oracle.postFallbackPrice(asset.target, 10n ** 18n);

    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("previewPrices selects the fallback price and shows unconfigured Chainlink/Band as zero", async function () {
    const [owner, bot] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = ethers.Wallet.createRandom().address;

    // FALLBACK-only asset: chainlinkFeed is still address(0) and bandBaseSymbol/bandQuoteSymbol are
    // still empty, so previewPrices' unconditional reads of all three sources exercise the
    // "unconfigured" branch of _readChainlink and _readBand even though this asset only uses FALLBACK.
    await oracle.setFallbackConfig(asset, 3600);
    await oracle.setAssetOracle(asset, bot.address, true);
    await oracle.setOracleType(asset, 3);
    await oracle.connect(bot).postFallbackPrice(asset, 6n * 10n ** 18n);

    const preview = await oracle.previewPrices(asset);
    expect(preview.chainlinkPriceMantissa).to.equal(0);
    expect(preview.bandPriceMantissa).to.equal(0);
    expect(preview.fallbackPriceMantissa).to.equal(6n * 10n ** 18n);
    expect(preview.selectedPriceMantissa).to.equal(6n * 10n ** 18n);
  });

  it("previewPrices leaves selectedPriceMantissa at zero for a fully unconfigured (UNSET) asset", async function () {
    const [owner] = await ethers.getSigners();
    // No Band reference configured at all (distinct from other previewPrices tests, which all pass
    // a real Band contract): exercises _readBand's own bandStdReference==0 early return, which
    // setOracleType's separate bandStdReference==0 check can never reach on its own since it always
    // reverts before an asset's oracleType could ever be set to BAND.
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, ethers.ZeroAddress);
    const asset = ethers.Wallet.createRandom().address;

    // setOracleType was never called at all, so oracleType stays UNSET -- none of the
    // CHAINLINK/BAND/FALLBACK branches match and selectedPriceMantissa keeps its zero default.
    const preview = await oracle.previewPrices(asset);
    expect(preview.oracleType).to.equal(0);
    expect(preview.chainlinkPriceMantissa).to.equal(0);
    expect(preview.bandPriceMantissa).to.equal(0);
    expect(preview.fallbackPriceMantissa).to.equal(0);
    expect(preview.selectedPriceMantissa).to.equal(0);
  });

  it("previewPrices selects the Chainlink price when that's the active oracle type", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const agg = await (await ethers.getContractFactory("MockChainlinkAggregator")).deploy(18);
    const latest = await ethers.provider.getBlock("latest");

    await agg.setRoundData(7n * 10n ** 18n, BigInt(latest!.timestamp), 1);
    await oracle.setChainlinkConfig(asset.target, agg.target, 3600);
    await oracle.setOracleType(asset.target, 1);

    const preview = await oracle.previewPrices(asset.target);
    expect(preview.chainlinkPriceMantissa).to.equal(7n * 10n ** 18n);
    expect(preview.selectedPriceMantissa).to.equal(7n * 10n ** 18n);
  });

  it("restricts every admin setter to the owner", async function () {
    const [owner, other, bot] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = ethers.Wallet.createRandom().address;
    const REVERT = "Ownable: caller is not the owner";

    await expect(oracle.connect(other).setBandStdReference(band.target)).to.be.revertedWith(REVERT);
    await expect(oracle.connect(other).setAssetOracle(asset, bot.address, true)).to.be.revertedWith(REVERT);
    await expect(oracle.connect(other).setOracleType(asset, 3)).to.be.revertedWith(REVERT);
    await expect(oracle.connect(other).setCTokenUnderlying(asset, asset)).to.be.revertedWith(REVERT);
    await expect(oracle.connect(other).setFallbackConfig(asset, 3600)).to.be.revertedWith(REVERT);
    await expect(oracle.connect(other).setChainlinkConfig(asset, bot.address, 3600)).to.be.revertedWith(REVERT);
    await expect(oracle.connect(other).setBandConfig(asset, "XRP", "USD", 3600)).to.be.revertedWith(REVERT);
    await expect(oracle.connect(other).activateCircuitBreaker(asset, 60)).to.be.revertedWith(REVERT);
    await expect(oracle.connect(other).deactivateCircuitBreaker(asset)).to.be.revertedWith(REVERT);
  });

  it("reports MissingBandConfig via the bandStdReference==0 clause when no Band reference was ever set", async function () {
    const [owner] = await ethers.getSigners();
    // Deploy with the zero address as the Band reference -- distinct from the existing "base symbol
    // never configured" case, which uses a real Band reference from deployment.
    const oracle = await (
      await ethers.getContractFactory("SecurdPriceOracle")
    ).deploy(owner.address, ethers.ZeroAddress);
    const asset = ethers.Wallet.createRandom().address;

    await expect(oracle.setOracleType(asset, 2)).to.be.revertedWithCustomError(oracle, "MissingBandConfig");
  });

  it("fails safe to zero for Chainlink data with a zero updatedAt or a stale answeredInRound", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);
    const agg = await (await ethers.getContractFactory("MockChainlinkAggregator")).deploy(18);
    const latest = await ethers.provider.getBlock("latest");

    await oracle.setChainlinkConfig(asset.target, agg.target, 3600);
    await oracle.setOracleType(asset.target, 1);

    // Positive answer, but updatedAt == 0.
    await agg.setRoundData(5n * 10n ** 18n, 0, 1);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);

    // Positive answer, real updatedAt, but answeredInRound (0) < the mock's hardcoded roundId (1).
    await agg.setRoundData(5n * 10n ** 18n, BigInt(latest!.timestamp), 0);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });

  it("uses the earlier of lastUpdatedBase/lastUpdatedQuote for Band staleness regardless of which is older", async function () {
    const [owner] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const asset = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset.target);
    const latest = await ethers.provider.getBlock("latest");
    const now = BigInt(latest!.timestamp);

    await oracle.setBandConfig(asset.target, "XRP", "USD", 100);
    await oracle.setOracleType(asset.target, 2);

    // lastUpdatedBase older than lastUpdatedQuote: minUpdated = lastUpdatedBase, already stale.
    await band.setReferenceData(5n * 10n ** 18n, now - 150n, now);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);

    // lastUpdatedQuote older than lastUpdatedBase: minUpdated = lastUpdatedQuote, already stale.
    await band.setReferenceData(5n * 10n ** 18n, now, now - 150n);
    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(0);
  });
});
