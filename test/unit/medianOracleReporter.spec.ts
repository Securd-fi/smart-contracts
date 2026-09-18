import { expect } from "chai";
import { ethers } from "hardhat";

describe("SecurdMedianOracleReporter", function () {
  it("aggregates reporter submissions and forwards the median price to the fallback oracle", async function () {
    const [owner, reporter1, reporter2, reporter3] = await ethers.getSigners();
    // Real 18-decimal mock token, not a bare EOA address: getUnderlyingPrice now reads decimals()
    // on the asset to apply the underlying-decimals scaling fix, which needs an actual contract.
    // 18 decimals keeps the scale factor at 1x so every existing assertion below is unchanged.
    const assetContract = await (await ethers.getContractFactory("MockERC20")).deploy("Asset", "AST", 18);
    const asset = assetContract.target;

    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const reporter = await (await ethers.getContractFactory("SecurdMedianOracleReporter")).deploy(
      owner.address,
      oracle.target
    ) as any;
    const cToken = await (await ethers.getContractFactory("MockCTokenWithUnderlying")).deploy(asset);

    await oracle.setFallbackConfig(asset, 3600);
    await oracle.setOracleType(asset, 3);
    await oracle.setAssetOracle(asset, reporter.target, true);

    await reporter.setAssetConfig(asset, 100, 3);
    await reporter.setReporter(asset, reporter1.address, true);
    await reporter.setReporter(asset, reporter2.address, true);
    await reporter.setReporter(asset, reporter3.address, true);

    await reporter.connect(reporter1).submitPrice(asset, 1, 2n * 10n ** 18n);
    await reporter.connect(reporter2).submitPrice(asset, 1, 4n * 10n ** 18n);
    await reporter.connect(reporter3).submitPrice(asset, 1, 3n * 10n ** 18n);

    await ethers.provider.send("evm_increaseTime", [101]);
    await ethers.provider.send("evm_mine", []);

    await expect(reporter.finalizeRound(asset, 1))
      .to.emit(reporter, "RoundPosted")
      .withArgs(asset, 1, 3n * 10n ** 18n, 3);

    expect(await oracle.getUnderlyingPrice(cToken.target)).to.equal(3n * 10n ** 18n);
  });

  it("enforces reporter authorization, duplicate protection, and pause controls", async function () {
    const [owner, reporter1, outsider] = await ethers.getSigners();
    const asset = ethers.Wallet.createRandom().address;

    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const reporter = await (await ethers.getContractFactory("SecurdMedianOracleReporter")).deploy(
      owner.address,
      oracle.target
    ) as any;

    await reporter.setAssetConfig(asset, 100, 2);
    await reporter.setReporter(asset, reporter1.address, true);

    await expect(reporter.connect(outsider).submitPrice(asset, 1, 1n)).to.be.revertedWithCustomError(
      reporter,
      "ReporterNotAuthorized"
    );

    await reporter.connect(reporter1).submitPrice(asset, 1, 1n);
    await expect(reporter.connect(reporter1).submitPrice(asset, 1, 2n)).to.be.revertedWithCustomError(
      reporter,
      "DuplicateSubmission"
    );

    await reporter.pause();
    await expect(reporter.connect(reporter1).submitPrice(asset, 2, 1n)).to.be.revertedWith("Pausable: paused");

    await reporter.unpause();
    await reporter.connect(reporter1).submitPrice(asset, 2, 1n);
  });

  async function deployFixture() {
    const [owner, reporter1, reporter2, reporter3, reporter4, outsider] = await ethers.getSigners();
    const band = await (await ethers.getContractFactory("MockBandStdReference")).deploy();
    const oracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, band.target);
    const reporter = (await (await ethers.getContractFactory("SecurdMedianOracleReporter")).deploy(
      owner.address,
      oracle.target
    )) as any;
    const asset = ethers.Wallet.createRandom().address;
    return { owner, reporter1, reporter2, reporter3, reporter4, outsider, reporter, oracle, asset };
  }

  it("transfers ownership when the initial owner differs from the deployer", async function () {
    const [deployer, owner] = await ethers.getSigners();
    const oracle = await (
      await ethers.getContractFactory("SecurdPriceOracle")
    ).deploy(owner.address, ethers.ZeroAddress);
    const reporter = await (await ethers.getContractFactory("SecurdMedianOracleReporter"))
      .connect(deployer)
      .deploy(owner.address, oracle.target);
    expect(await reporter.owner()).to.equal(owner.address);
  });

  it("rejects a zero owner or zero fallback oracle at construction", async function () {
    const [owner] = await ethers.getSigners();
    const Reporter = await ethers.getContractFactory("SecurdMedianOracleReporter");
    await expect(Reporter.deploy(ethers.ZeroAddress, owner.address)).to.be.revertedWithCustomError(
      Reporter,
      "InvalidReporter"
    );
    await expect(Reporter.deploy(owner.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      Reporter,
      "InvalidOracle"
    );
  });

  it("rejects zero-address arguments and out-of-range config on setReporter/setAssetConfig", async function () {
    const { reporter, asset, reporter1 } = await deployFixture();

    await expect(reporter.setReporter(ethers.ZeroAddress, reporter1.address, true)).to.be.revertedWithCustomError(
      reporter,
      "InvalidAsset"
    );
    await expect(reporter.setReporter(asset, ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
      reporter,
      "InvalidReporter"
    );

    await expect(reporter.setAssetConfig(ethers.ZeroAddress, 100, 2)).to.be.revertedWithCustomError(
      reporter,
      "InvalidAsset"
    );
    await expect(reporter.setAssetConfig(asset, 0, 2)).to.be.revertedWithCustomError(reporter, "InvalidSubmission");
    await expect(reporter.setAssetConfig(asset, 100, 0)).to.be.revertedWithCustomError(reporter, "InvalidSubmission");
    await expect(reporter.setAssetConfig(asset, 100, 51)).to.be.revertedWithCustomError(
      reporter,
      "InvalidSubmission"
    );
  });

  it("restricts pause/unpause/cancelRound/setReporter/setAssetConfig to the owner", async function () {
    const { reporter, asset, outsider } = await deployFixture();
    const REVERT = "Ownable: caller is not the owner";

    await expect(reporter.connect(outsider).pause()).to.be.revertedWith(REVERT);
    await expect(reporter.connect(outsider).unpause()).to.be.revertedWith(REVERT);
    await expect(reporter.connect(outsider).cancelRound(asset, 1)).to.be.revertedWith(REVERT);
    await expect(reporter.connect(outsider).setReporter(asset, outsider.address, true)).to.be.revertedWith(REVERT);
    await expect(reporter.connect(outsider).setAssetConfig(asset, 100, 2)).to.be.revertedWith(REVERT);
  });

  it("cancels a stuck round and rejects invalid or already-finalized cancellations", async function () {
    const { reporter, asset, reporter1 } = await deployFixture();
    await reporter.setAssetConfig(asset, 100, 2);
    await reporter.setReporter(asset, reporter1.address, true);
    await reporter.connect(reporter1).submitPrice(asset, 1, 5n * 10n ** 18n);

    await expect(reporter.cancelRound(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(
      reporter,
      "InvalidAsset"
    );
    await expect(reporter.cancelRound(asset, 0)).to.be.revertedWithCustomError(reporter, "InvalidRound");

    await expect(reporter.cancelRound(asset, 1)).to.emit(reporter, "RoundCancelled").withArgs(asset, 1);
    await expect(reporter.cancelRound(asset, 1)).to.be.revertedWithCustomError(reporter, "RoundAlreadyFinalized");

    // A cancelled round cannot receive further submissions.
    await expect(reporter.connect(reporter1).submitPrice(asset, 1, 6n * 10n ** 18n)).to.be.revertedWithCustomError(
      reporter,
      "RoundAlreadyFinalized"
    );
  });

  it("rejects submitPrice with invalid arguments or before the asset is configured", async function () {
    const { reporter, asset, reporter1, owner } = await deployFixture();

    await expect(reporter.submitPrice(ethers.ZeroAddress, 1, 1n)).to.be.revertedWithCustomError(
      reporter,
      "InvalidAsset"
    );
    await expect(reporter.submitPrice(asset, 0, 1n)).to.be.revertedWithCustomError(reporter, "InvalidRound");

    // Owner is implicitly an authorized reporter for any asset, so this reaches the priceMantissa
    // and "asset not configured" checks rather than ReporterNotAuthorized.
    await expect(reporter.submitPrice(asset, 1, 0)).to.be.revertedWithCustomError(reporter, "InvalidSubmission");
    await expect(reporter.submitPrice(asset, 1, 1n)).to.be.revertedWithCustomError(reporter, "InvalidSubmission");

    await reporter.setAssetConfig(asset, 100, 2);
    await reporter.setReporter(asset, reporter1.address, true);
    await reporter.connect(reporter1).submitPrice(asset, 1, 1n);

    // Round expiry: advance past the deadline before a second reporter submits.
    await ethers.provider.send("evm_increaseTime", [101]);
    await ethers.provider.send("evm_mine", []);
    await expect(reporter.connect(owner).submitPrice(asset, 1, 2n)).to.be.revertedWithCustomError(
      reporter,
      "RoundExpired"
    );
  });

  it("rejects finalizeRound with invalid arguments, before the round closes, or below quorum", async function () {
    const { reporter, asset, reporter1 } = await deployFixture();

    await expect(reporter.finalizeRound(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(
      reporter,
      "InvalidAsset"
    );
    await expect(reporter.finalizeRound(asset, 0)).to.be.revertedWithCustomError(reporter, "InvalidRound");

    // No deadline set yet (no submissions ever made) -- round is "still open".
    await expect(reporter.finalizeRound(asset, 1)).to.be.revertedWithCustomError(reporter, "RoundStillOpen");

    await reporter.setAssetConfig(asset, 100, 2);
    await reporter.setReporter(asset, reporter1.address, true);
    await reporter.connect(reporter1).submitPrice(asset, 1, 5n * 10n ** 18n);

    // Deadline set but not yet reached.
    await expect(reporter.finalizeRound(asset, 1)).to.be.revertedWithCustomError(reporter, "RoundStillOpen");

    await ethers.provider.send("evm_increaseTime", [101]);
    await ethers.provider.send("evm_mine", []);

    // Deadline passed but only 1 of the required 2 submissions came in.
    await expect(reporter.finalizeRound(asset, 1)).to.be.revertedWithCustomError(
      reporter,
      "InsufficientSubmissions"
    );
  });

  it("rejects finalizing an already-finalized round", async function () {
    const { reporter, oracle, asset, reporter1, reporter2 } = await deployFixture();
    await oracle.setAssetOracle(asset, reporter.target, true);
    await reporter.setAssetConfig(asset, 100, 2);
    await reporter.setReporter(asset, reporter1.address, true);
    await reporter.setReporter(asset, reporter2.address, true);
    await reporter.connect(reporter1).submitPrice(asset, 1, 5n * 10n ** 18n);
    await reporter.connect(reporter2).submitPrice(asset, 1, 7n * 10n ** 18n);

    await ethers.provider.send("evm_increaseTime", [101]);
    await ethers.provider.send("evm_mine", []);

    await reporter.finalizeRound(asset, 1);
    await expect(reporter.finalizeRound(asset, 1)).to.be.revertedWithCustomError(reporter, "RoundAlreadyFinalized");
  });

  it("computes an averaged median for an even number of submissions and exposes getRoundPrices", async function () {
    const { reporter, oracle, asset, reporter1, reporter2, reporter3, reporter4 } = await deployFixture();
    await oracle.setAssetOracle(asset, reporter.target, true);
    await reporter.setAssetConfig(asset, 100, 4);
    for (const r of [reporter1, reporter2, reporter3, reporter4]) {
      await reporter.setReporter(asset, r.address, true);
    }

    // Sorted: [1,2,3,4]*1e18 -- even length, median = average of the two middle values = 2.5e18.
    await reporter.connect(reporter1).submitPrice(asset, 1, 4n * 10n ** 18n);
    await reporter.connect(reporter2).submitPrice(asset, 1, 1n * 10n ** 18n);
    await reporter.connect(reporter3).submitPrice(asset, 1, 3n * 10n ** 18n);
    await reporter.connect(reporter4).submitPrice(asset, 1, 2n * 10n ** 18n);

    const prices = await reporter.getRoundPrices(asset, 1);
    expect(prices.map((p: bigint) => p.toString()).sort()).to.deep.equal(
      ["1000000000000000000", "2000000000000000000", "3000000000000000000", "4000000000000000000"]
    );

    await ethers.provider.send("evm_increaseTime", [101]);
    await ethers.provider.send("evm_mine", []);

    await expect(reporter.finalizeRound(asset, 1))
      .to.emit(reporter, "RoundPosted")
      .withArgs(asset, 1, 25n * 10n ** 17n, 4);
  });

  it("rejects a duplicate submission from the same reporter and caps submissions per round", async function () {
    const { reporter, asset, reporter1 } = await deployFixture();
    await reporter.setAssetConfig(asset, 1000, 2);
    await reporter.setReporter(asset, reporter1.address, true);
    await reporter.connect(reporter1).submitPrice(asset, 1, 1n);
    await expect(reporter.connect(reporter1).submitPrice(asset, 1, 2n)).to.be.revertedWithCustomError(
      reporter,
      "DuplicateSubmission"
    );

    // MAX_SUBMISSIONS_PER_ROUND = 50: fund and authorize 50 fresh reporters, submit from each, then
    // confirm the 51st is rejected. Reuses one funded wallet instead of 50 real signers.
    const wallets = [];
    for (let i = 0; i < 50; i++) {
      const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
      await ethers.provider.send("hardhat_setBalance", [wallet.address, "0x56BC75E2D63100000"]); // 100 ETH
      await reporter.setReporter(asset, wallet.address, true);
      wallets.push(wallet);
    }
    for (const wallet of wallets) {
      await reporter.connect(wallet).submitPrice(asset, 2, 1n);
    }

    const overflowWallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [overflowWallet.address, "0x56BC75E2D63100000"]);
    await reporter.setReporter(asset, overflowWallet.address, true);
    await expect(reporter.connect(overflowWallet).submitPrice(asset, 2, 1n)).to.be.revertedWithCustomError(
      reporter,
      "InvalidSubmission"
    );
  });
});
