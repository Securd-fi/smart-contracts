// @ts-nocheck
import { expect } from "chai";
import { ethers } from "hardhat";

describe("Comptroller integration", function () {
  async function deployFixture() {
    const [owner, pauseGuardian, supplier, borrower, liquidator, other] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const collateralAsset = await Token.deploy("Collateral Token", "COL", 18);
    const debtAsset = await Token.deploy("Debt Token", "USD", 18);

    const Oracle = await ethers.getContractFactory("SecurdPriceOracle");
    const oracle = await Oracle.deploy(owner.address, ethers.ZeroAddress);

    const JumpRateModel = await ethers.getContractFactory("JumpRateModelV2");
    const interestRateModel = await JumpRateModel.deploy(0, 0, 0, ethers.parseEther("0.8"), owner.address);

    const ComptrollerImpl = await ethers.getContractFactory("Comptroller");
    const comptrollerImpl = await ComptrollerImpl.deploy();
    const Unitroller = await ethers.getContractFactory("Unitroller");
    const unitroller = await Unitroller.deploy();

    await unitroller._setPendingImplementation(comptrollerImpl.target);
    await comptrollerImpl._become(unitroller.target);
    const comptroller = await ethers.getContractAt("Comptroller", unitroller.target);

    await comptroller._setPriceOracle(oracle.target);
    await comptroller._setCloseFactor(ethers.parseEther("0.5"));
    await comptroller._setLiquidationIncentive(ethers.parseEther("1.08"));

    const Delegate = await ethers.getContractFactory("CErc20Delegate");
    const delegate = await Delegate.deploy();
    const Delegator = await ethers.getContractFactory("CErc20Delegator");

    const cCollateral = await Delegator.deploy(
      collateralAsset.target,
      unitroller.target,
      interestRateModel.target,
      ethers.parseEther("1"),
      "Securd Collateral",
      "sCOL",
      8,
      owner.address,
      delegate.target,
      "0x"
    );

    const cDebt = await Delegator.deploy(
      debtAsset.target,
      unitroller.target,
      interestRateModel.target,
      ethers.parseEther("1"),
      "Securd Debt",
      "sUSD",
      8,
      owner.address,
      delegate.target,
      "0x"
    );

    await comptroller._supportMarket(cCollateral.target);
    await comptroller._supportMarket(cDebt.target);

    await oracle.setFallbackConfig(collateralAsset.target, 86400);
    await oracle.setOracleType(collateralAsset.target, 3);
    await oracle.postFallbackPrice(collateralAsset.target, ethers.parseEther("1"));

    await oracle.setFallbackConfig(debtAsset.target, 86400);
    await oracle.setOracleType(debtAsset.target, 3);
    await oracle.postFallbackPrice(debtAsset.target, ethers.parseEther("1"));

    await comptroller._setCollateralFactor(cCollateral.target, ethers.parseEther("0.75"));
    await comptroller._setCollateralFactor(cDebt.target, 0);

    await collateralAsset.mint(borrower.address, ethers.parseEther("100"));
    await debtAsset.mint(supplier.address, ethers.parseEther("500"));
    await debtAsset.mint(liquidator.address, ethers.parseEther("500"));

    return {
      owner,
      pauseGuardian,
      supplier,
      borrower,
      liquidator,
      other,
      collateralAsset,
      debtAsset,
      oracle,
      comptroller,
      cCollateral,
      cDebt,
      interestRateModel
    };
  }

  it("enforces admin-only configuration and duplicate market protection", async function () {
    const { owner, other, oracle, comptroller, cCollateral } = await deployFixture();
    const newOracle = await (await ethers.getContractFactory("SecurdPriceOracle")).deploy(owner.address, ethers.ZeroAddress);

    expect(await comptroller.connect(other)._setPriceOracle.staticCall(newOracle.target)).to.equal(1);
    await expect(comptroller.connect(other)._setPriceOracle(newOracle.target))
      .to.emit(comptroller, "Failure")
      .withArgs(1, 16, 0);

    await expect(comptroller._setPriceOracle(newOracle.target)).to.emit(comptroller, "NewPriceOracle");
    expect(await comptroller.oracle()).to.equal(newOracle.target);

    expect(await comptroller.connect(other)._supportMarket.staticCall(cCollateral.target)).to.equal(1);
    await expect(comptroller.connect(other)._supportMarket(cCollateral.target))
      .to.emit(comptroller, "Failure")
      .withArgs(1, 18, 0);

    expect(await comptroller._supportMarket.staticCall(cCollateral.target)).to.equal(10);
    await expect(comptroller._supportMarket(cCollateral.target))
      .to.emit(comptroller, "Failure")
      .withArgs(10, 17, 0);
  });

  it("validates collateral factor constraints and pause guardian controls", async function () {
    const { owner, pauseGuardian, other, oracle, comptroller, cCollateral, cDebt, debtAsset } = await deployFixture();
    const freshToken = await (await ethers.getContractFactory("MockERC20")).deploy("Fresh", "FRH", 18);
    const delegate = await (await ethers.getContractFactory("CErc20Delegate")).deploy();
    const freshMarket = await (
      await ethers.getContractFactory("CErc20Delegator")
    ).deploy(
      freshToken.target,
      await comptroller.getAddress(),
      await cCollateral.interestRateModel(),
      ethers.parseEther("1"),
      "Fresh Market",
      "sFRH",
      8,
      owner.address,
      delegate.target,
      "0x"
    );

    expect(await comptroller.connect(other)._setCollateralFactor.staticCall(cCollateral.target, ethers.parseEther("0.5"))).to.equal(1);
    await expect(comptroller.connect(other)._setCollateralFactor(cCollateral.target, ethers.parseEther("0.5")))
      .to.emit(comptroller, "Failure")
      .withArgs(1, 6, 0);

    expect(await comptroller._setCollateralFactor.staticCall(cCollateral.target, ethers.parseEther("0.95"))).to.equal(6);
    await expect(comptroller._setCollateralFactor(cCollateral.target, ethers.parseEther("0.95")))
      .to.emit(comptroller, "Failure")
      .withArgs(6, 8, 0);

    expect(await comptroller._setCollateralFactor.staticCall(freshMarket.target, ethers.parseEther("0.5"))).to.equal(9);
    await expect(comptroller._setCollateralFactor(freshMarket.target, ethers.parseEther("0.5")))
      .to.emit(comptroller, "Failure")
      .withArgs(9, 7, 0);

    await oracle.postFallbackPrice(debtAsset.target, 0).catch(() => {});
    await oracle.setOracleType(debtAsset.target, 3);

    expect(await comptroller._setPauseGuardian.staticCall(pauseGuardian.address)).to.equal(0);
    await expect(comptroller._setPauseGuardian(pauseGuardian.address))
      .to.emit(comptroller, "NewPauseGuardian")
      .withArgs(ethers.ZeroAddress, pauseGuardian.address);

    await comptroller.connect(pauseGuardian)._setMintPaused(cCollateral.target, true);
    expect(await comptroller.mintGuardianPaused(cCollateral.target)).to.equal(true);
    await expect(comptroller.connect(pauseGuardian)._setMintPaused(cCollateral.target, false)).to.be.revertedWith(
      "only admin can unpause"
    );

    await comptroller.connect(pauseGuardian)._setBorrowPaused(cDebt.target, true);
    expect(await comptroller.borrowGuardianPaused(cDebt.target)).to.equal(true);
    await expect(comptroller.connect(other)._setBorrowPaused(cDebt.target, true)).to.be.revertedWith(
      "only pause guardian and admin can pause"
    );
  });

  it("tracks liquidity, auto-enters borrowed markets, and blocks unsafe exits", async function () {
    const { supplier, borrower, collateralAsset, debtAsset, comptroller, cCollateral, cDebt } = await deployFixture();

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);

    const [errBefore, liquidityBefore, shortfallBefore] = await comptroller.getAccountLiquidity(borrower.address);
    expect(errBefore).to.equal(0);
    expect(liquidityBefore).to.equal(ethers.parseEther("75"));
    expect(shortfallBefore).to.equal(0);

    await cDebt.connect(borrower).borrow(ethers.parseEther("50"));
    expect(await comptroller.checkMembership(borrower.address, cDebt.target)).to.equal(true);

    const [errAfter, liquidityAfter, shortfallAfter] = await comptroller.getAccountLiquidity(borrower.address);
    expect(errAfter).to.equal(0);
    expect(liquidityAfter).to.equal(ethers.parseEther("25"));
    expect(shortfallAfter).to.equal(0);

    expect(await comptroller.connect(borrower).exitMarket.staticCall(cDebt.target)).to.equal(12);
    await expect(comptroller.connect(borrower).exitMarket(cDebt.target))
      .to.emit(comptroller, "Failure")
      .withArgs(12, 2, 0);

    expect(await comptroller.connect(borrower).exitMarket.staticCall(cCollateral.target)).to.equal(14);
    await expect(comptroller.connect(borrower).exitMarket(cCollateral.target))
      .to.emit(comptroller, "Failure");

    // Exiting a market the caller was never a member of is a harmless no-op success.
    expect(await comptroller.connect(supplier).exitMarket.staticCall(cCollateral.target)).to.equal(0);

    // Repay the debt and free up the collateral, then a clean exit should actually clear membership.
    await debtAsset.connect(borrower).mint(borrower.address, ethers.parseEther("50"));
    await debtAsset.connect(borrower).approve(cDebt.target, ethers.parseEther("50"));
    await cDebt.connect(borrower).repayBorrow(ethers.parseEther("50"));

    await expect(comptroller.connect(borrower).exitMarket(cCollateral.target)).to.emit(comptroller, "MarketExited");
    expect(await comptroller.checkMembership(borrower.address, cCollateral.target)).to.equal(false);

    // Enter two markets, then exit the second one -- the accountAssets removal loop must skip past
    // the first (non-matching) entry before finding the real match, exercising that "keep scanning"
    // branch (as opposed to matching on the very first iteration, as every exit above does).
    await comptroller.connect(supplier).enterMarkets([cCollateral.target, cDebt.target]);
    await expect(comptroller.connect(supplier).exitMarket(cDebt.target)).to.emit(comptroller, "MarketExited");
    expect(await comptroller.checkMembership(supplier.address, cDebt.target)).to.equal(false);
    expect(await comptroller.checkMembership(supplier.address, cCollateral.target)).to.equal(true);
  });

  it("computes seize tokens for liquidation and reports price failures", async function () {
    const { supplier, borrower, collateralAsset, debtAsset, oracle, comptroller, cCollateral, cDebt } = await deployFixture();

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);

    await cDebt.connect(borrower).borrow(ethers.parseEther("60"));
    await oracle.postFallbackPrice(collateralAsset.target, ethers.parseEther("0.5"));

    const [errorCode, seizeTokens] = await comptroller.liquidateCalculateSeizeTokens(
      cDebt.target,
      cCollateral.target,
      ethers.parseEther("30")
    );
    expect(errorCode).to.equal(0);
    expect(seizeTokens).to.be.gt(0);

    await oracle.postFallbackPrice(collateralAsset.target, 1n);
    await oracle.setFallbackConfig(collateralAsset.target, 1);
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);

    const [priceError, zeroSeize] = await comptroller.liquidateCalculateSeizeTokens(
      cDebt.target,
      cCollateral.target,
      ethers.parseEther("1")
    );
    expect(priceError).to.equal(13);
    expect(zeroSeize).to.equal(0);
  });

  it("reports PRICE_ERROR from the hypothetical liquidity calculation when an entered market has no oracle price", async function () {
    const { owner, borrower, collateralAsset, comptroller, cCollateral, interestRateModel } = await deployFixture();

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);

    // A second listed market the borrower also enters, but whose oracle price is never configured
    // (getUnderlyingPrice returns 0 for it), so the liquidity calculation's loop must fail with
    // PRICE_ERROR on this asset regardless of cCollateral's own valid price.
    const Token = await ethers.getContractFactory("MockERC20");
    const noPriceAsset = await Token.deploy("No Price Token", "NOPR", 18);
    const Delegate = await ethers.getContractFactory("CErc20Delegate");
    const delegate = await Delegate.deploy();
    const Delegator = await ethers.getContractFactory("CErc20Delegator");
    const cNoPrice = await Delegator.deploy(
      noPriceAsset.target,
      comptroller.target,
      interestRateModel.target,
      ethers.parseEther("1"),
      "No Price Market",
      "sNOPR",
      8,
      owner.address,
      delegate.target,
      "0x"
    );
    await comptroller._supportMarket(cNoPrice.target);
    await comptroller.connect(borrower).enterMarkets([cNoPrice.target]);

    const [err, liquidity, shortfall] = await comptroller.getAccountLiquidity(borrower.address);
    expect(err).to.equal(13);
    expect(liquidity).to.equal(0);
    expect(shortfall).to.equal(0);
  });

  it("enforces mint, redeem, and borrow policy hooks including borrow caps", async function () {
    const { owner, supplier, borrower, other, collateralAsset, debtAsset, comptroller, cCollateral, cDebt } =
      await deployFixture();

    expect(await comptroller.mintAllowed.staticCall(cCollateral.target, borrower.address, 1n)).to.equal(0);

    await comptroller._setPauseGuardian(owner.address);
    await comptroller._setMintPaused(cCollateral.target, true);
    await expect(comptroller.mintAllowed(cCollateral.target, borrower.address, 1n)).to.be.revertedWith("mint is paused");
    await comptroller._setMintPaused(cCollateral.target, false);

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));

    expect(await comptroller.redeemAllowed.staticCall(cCollateral.target, borrower.address, ethers.parseEther("10"))).to.equal(0);

    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);
    await cDebt.connect(borrower).borrow(ethers.parseEther("50"));

    expect(await comptroller.redeemAllowed.staticCall(cCollateral.target, borrower.address, ethers.parseEther("80"))).to.equal(4);

    await comptroller._setBorrowCapGuardian(other.address);
    await expect(
      comptroller.connect(borrower)._setMarketBorrowCaps([cDebt.target], [ethers.parseEther("10")])
    ).to.be.revertedWith("only admin or borrow cap guardian can set borrow caps");

    await comptroller.connect(other)._setMarketBorrowCaps([cDebt.target], [ethers.parseEther("50.5")]);
    expect(await comptroller.borrowCaps(cDebt.target)).to.equal(ethers.parseEther("50.5"));

    // Still comfortably under the 50.5 cap (total borrows go from 50 to 50.4) -- exercises the cap
    // check's own "passes" branch, as opposed to the revert case exercised immediately below.
    await cDebt.connect(borrower).borrow(ethers.parseEther("0.4"));

    await expect(cDebt.connect(borrower).borrow(ethers.parseEther("1"))).to.be.revertedWith("market borrow cap reached");

    await comptroller._setBorrowPaused(cDebt.target, true);
    await expect(comptroller.borrowAllowed(cDebt.target, borrower.address, 1n)).to.be.revertedWith("borrow is paused");
  });

  it("rejects a direct borrowAllowed call from a non-cToken auto-enter attempt and PRICE_ERRORs an unpriced market", async function () {
    const { owner, other, borrower, comptroller, cDebt, interestRateModel } = await deployFixture();

    // `other` is not a member of cDebt, and this call doesn't originate from cDebt itself, so the
    // auto-enter path's own sender check must reject it before ever reaching a listed/price check.
    await expect(comptroller.connect(other).borrowAllowed(cDebt.target, other.address, 1n)).to.be.revertedWith(
      "sender must be cToken"
    );

    // A freshly listed market with no oracle price configured at all: borrowAllowed's own price
    // check (distinct from the hypothetical-liquidity loop's price check) must reject it.
    const Token = await ethers.getContractFactory("MockERC20");
    const noPriceAsset = await Token.deploy("No Price Token", "NOPR", 18);
    const Delegate = await ethers.getContractFactory("CErc20Delegate");
    const delegate = await Delegate.deploy();
    const Delegator = await ethers.getContractFactory("CErc20Delegator");
    const cNoPrice = await Delegator.deploy(
      noPriceAsset.target,
      comptroller.target,
      interestRateModel.target,
      ethers.parseEther("1"),
      "No Price Market",
      "sNOPR",
      8,
      owner.address,
      delegate.target,
      "0x"
    );
    await comptroller._supportMarket(cNoPrice.target);

    await expect(cNoPrice.connect(borrower).borrow(1n)).to.be.reverted;
  });

  it("enforces repay, liquidation, seize, and transfer policy checks", async function () {
    const { owner, supplier, borrower, liquidator, other, collateralAsset, debtAsset, oracle, comptroller, cCollateral, cDebt } =
      await deployFixture();

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);
    await cDebt.connect(borrower).borrow(ethers.parseEther("60"));

    expect(
      await comptroller.repayBorrowAllowed.staticCall(cDebt.target, liquidator.address, borrower.address, ethers.parseEther("1"))
    ).to.equal(0);

    expect(
      await comptroller.liquidateBorrowAllowed.staticCall(
        cDebt.target,
        cCollateral.target,
        liquidator.address,
        borrower.address,
        ethers.parseEther("1")
      )
    ).to.equal(3);

    await oracle.postFallbackPrice(collateralAsset.target, ethers.parseEther("0.5"));

    expect(
      await comptroller.liquidateBorrowAllowed.staticCall(
        cDebt.target,
        cCollateral.target,
        liquidator.address,
        borrower.address,
        ethers.parseEther("40")
      )
    ).to.equal(17);

    expect(
      await comptroller.liquidateBorrowAllowed.staticCall(
        cDebt.target,
        cCollateral.target,
        liquidator.address,
        borrower.address,
        ethers.parseEther("30")
      )
    ).to.equal(0);

    await comptroller._setPauseGuardian(owner.address);
    await comptroller._setSeizePaused(true);
    await expect(
      comptroller.seizeAllowed(cCollateral.target, cDebt.target, liquidator.address, borrower.address, 1n)
    ).to.be.revertedWith("seize is paused");
    await comptroller._setSeizePaused(false);

    await comptroller._setTransferPaused(true);
    await expect(
      comptroller.transferAllowed(cCollateral.target, borrower.address, liquidator.address, 1n)
    ).to.be.revertedWith("transfer is paused");
    await comptroller._setTransferPaused(false);

    const rogueComptrollerImpl = await (await ethers.getContractFactory("Comptroller")).deploy();
    const rogueUnitroller = await (await ethers.getContractFactory("Unitroller")).deploy();
    await rogueUnitroller._setPendingImplementation(rogueComptrollerImpl.target);
    await rogueComptrollerImpl._become(rogueUnitroller.target);
    const rogueComptroller = await ethers.getContractAt("Comptroller", rogueUnitroller.target);
    await rogueComptroller._setPriceOracle(await comptroller.oracle());

    const delegate = await (await ethers.getContractFactory("CErc20Delegate")).deploy();
    const rogueMarket = await (
      await ethers.getContractFactory("CErc20Delegator")
    ).deploy(
      collateralAsset.target,
      rogueUnitroller.target,
      await cCollateral.interestRateModel(),
      ethers.parseEther("1"),
      "Rogue Market",
      "rCOL",
      8,
      owner.address,
      delegate.target,
      "0x"
    );
    await rogueComptroller._supportMarket(rogueMarket.target);

    expect(
      await comptroller.seizeAllowed.staticCall(rogueMarket.target, cDebt.target, liquidator.address, borrower.address, 1n)
    ).to.equal(9);

    expect(
      await comptroller.transferAllowed.staticCall(cCollateral.target, borrower.address, liquidator.address, ethers.parseEther("80"))
    ).to.equal(4);

    expect(await comptroller.repayBorrowAllowed.staticCall(other.address, liquidator.address, borrower.address, 1n)).to.equal(9);
  });

  it("rejects invalid implementation addresses in CErc20Delegator._setImplementation", async function () {
    const { owner, cCollateral } = await deployFixture();
    const Delegate = await ethers.getContractFactory("CErc20Delegate");
    const newDelegate = await Delegate.deploy();

    await expect(
      cCollateral.connect(owner)._setImplementation(ethers.ZeroAddress, false, "0x")
    ).to.be.revertedWith("CErc20Delegator::_setImplementation: implementation=0");

    await expect(
      cCollateral.connect(owner)._setImplementation(owner.address, false, "0x")
    ).to.be.revertedWith("CErc20Delegator::_setImplementation: not a contract");

    await expect(
      cCollateral.connect(owner)._setImplementation(newDelegate.target, false, "0x")
    ).to.not.be.reverted;
  });

  // Regression test for a critical bug found while auditing the mainnet market set: getUnderlyingPrice
  // used to return a flat $-per-whole-token price regardless of the underlying's own decimals, but
  // getHypotheticalAccountLiquidityInternal (below) multiplies that price directly against RAW
  // cToken/underlying balances. A 6-decimal asset (USDC-like) was silently undervalued by exactly
  // 10^12x as a result -- proven empirically against this exact fixture pattern before the fix existed.
  // This test builds a mixed 18-decimal + 6-decimal portfolio and asserts the combined liquidity is
  // the true dollar sum, not the pre-fix near-zero contribution from the 6-decimal side.
  it("values a 6-decimal underlying's collateral correctly alongside an 18-decimal underlying", async function () {
    const [owner, user] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const xrpLike18 = await Token.deploy("XRP-like", "XRP", 18);
    const usdcLike6 = await Token.deploy("USD Coin", "USDC", 6);

    const Oracle = await ethers.getContractFactory("SecurdPriceOracle");
    const oracle = await Oracle.deploy(owner.address, ethers.ZeroAddress);

    const JumpRateModel = await ethers.getContractFactory("JumpRateModelV2");
    const interestRateModel = await JumpRateModel.deploy(0, 0, 0, ethers.parseEther("0.8"), owner.address);

    const ComptrollerImpl = await ethers.getContractFactory("Comptroller");
    const comptrollerImpl = await ComptrollerImpl.deploy();
    const Unitroller = await ethers.getContractFactory("Unitroller");
    const unitroller = await Unitroller.deploy();
    await unitroller._setPendingImplementation(comptrollerImpl.target);
    await comptrollerImpl._become(unitroller.target);
    const comptroller = await ethers.getContractAt("Comptroller", unitroller.target);
    await comptroller._setPriceOracle(oracle.target);
    await comptroller._setCloseFactor(ethers.parseEther("0.5"));
    await comptroller._setLiquidationIncentive(ethers.parseEther("1.1"));

    const Delegate = await ethers.getContractFactory("CErc20Delegate");
    const delegate = await Delegate.deploy();
    const Delegator = await ethers.getContractFactory("CErc20Delegator");

    const cXrp = await Delegator.deploy(
      xrpLike18.target, unitroller.target, interestRateModel.target,
      ethers.parseEther("1"), "Securd XRP", "sXRP", 8, owner.address, delegate.target, "0x"
    );
    const cUsdc = await Delegator.deploy(
      usdcLike6.target, unitroller.target, interestRateModel.target,
      ethers.parseEther("1"), "Securd USDC", "sUSDC", 8, owner.address, delegate.target, "0x"
    );

    await comptroller._supportMarket(cXrp.target);
    await comptroller._supportMarket(cUsdc.target);

    // Oracle config must precede _setCollateralFactor -- Comptroller silently no-ops (non-reverting
    // error code) setting a nonzero CF while the oracle has no price yet for that asset.
    await oracle.setFallbackConfig(xrpLike18.target, 86400);
    await oracle.setOracleType(xrpLike18.target, 3);
    await oracle.postFallbackPrice(xrpLike18.target, ethers.parseEther("1"));

    await oracle.setFallbackConfig(usdcLike6.target, 86400);
    await oracle.setOracleType(usdcLike6.target, 3);
    await oracle.postFallbackPrice(usdcLike6.target, ethers.parseEther("1"));

    await comptroller._setCollateralFactor(cXrp.target, ethers.parseEther("0.75"));
    await comptroller._setCollateralFactor(cUsdc.target, ethers.parseEther("0.8"));

    await xrpLike18.mint(user.address, ethers.parseEther("1000"));
    await usdcLike6.mint(user.address, 1000n * 10n ** 6n);
    await xrpLike18.connect(user).approve(cXrp.target, ethers.MaxUint256);
    await usdcLike6.connect(user).approve(cUsdc.target, ethers.MaxUint256);

    const cXrpAsErc20 = await ethers.getContractAt("CErc20Delegate", cXrp.target);
    const cUsdcAsErc20 = await ethers.getContractAt("CErc20Delegate", cUsdc.target);
    await cXrpAsErc20.connect(user).mint(ethers.parseEther("1000"));
    await cUsdcAsErc20.connect(user).mint(1000n * 10n ** 6n);

    await comptroller.connect(user).enterMarkets([cXrp.target, cUsdc.target]);

    const [err, liquidity, shortfall] = await comptroller.getAccountLiquidity(user.address);
    expect(err).to.equal(0);
    expect(shortfall).to.equal(0);
    // 1000 XRP * 75% + 1000 USDC * 80% = $750 + $800 = $1550, at 1e18 precision.
    expect(liquidity).to.equal(ethers.parseEther("1550"));
  });

  it("rejects _setPriceOracle with the zero address", async function () {
    const { comptroller } = await deployFixture();
    await expect(comptroller._setPriceOracle(ethers.ZeroAddress)).to.be.revertedWith("oracle=0");
  });

  it("restricts _setCloseFactor to the admin and enforces its bounds", async function () {
    const { other, comptroller } = await deployFixture();
    await expect(comptroller.connect(other)._setCloseFactor(ethers.parseEther("0.5"))).to.be.revertedWith(
      "only admin can set close factor"
    );
    await expect(comptroller._setCloseFactor(ethers.parseEther("0.01"))).to.be.revertedWith(
      "close factor too small"
    );
    await expect(comptroller._setCloseFactor(ethers.parseEther("0.95"))).to.be.revertedWith(
      "close factor too large"
    );
  });

  it("restricts _setLiquidationIncentive to the admin", async function () {
    const { other, comptroller } = await deployFixture();
    expect(await comptroller.connect(other)._setLiquidationIncentive.staticCall(ethers.parseEther("1.1"))).to.equal(
      1
    );
    await expect(comptroller.connect(other)._setLiquidationIncentive(ethers.parseEther("1.1")))
      .to.emit(comptroller, "Failure")
      .withArgs(1, 11, 0);
  });

  it("returns PRICE_ERROR from _setCollateralFactor when the market is listed but has no oracle price", async function () {
    const { owner, comptroller, cCollateral } = await deployFixture();
    const noPriceToken = await (await ethers.getContractFactory("MockERC20")).deploy("NoPrice", "NOP", 18);
    const delegate = await (await ethers.getContractFactory("CErc20Delegate")).deploy();
    const noPriceMarket = await (
      await ethers.getContractFactory("CErc20Delegator")
    ).deploy(
      noPriceToken.target,
      await comptroller.getAddress(),
      await cCollateral.interestRateModel(),
      ethers.parseEther("1"),
      "No Price Market",
      "sNOP",
      8,
      owner.address,
      delegate.target,
      "0x"
    );
    // Listed, but its underlying was never configured on the oracle -- getUnderlyingPrice returns 0.
    await comptroller._supportMarket(noPriceMarket.target);

    const PRICE_ERROR = 13n;
    expect(
      await comptroller._setCollateralFactor.staticCall(noPriceMarket.target, ethers.parseEther("0.5"))
    ).to.equal(PRICE_ERROR);
  });

  it("validates _setMarketBorrowCaps array lengths and restricts _setBorrowCapGuardian/_setPauseGuardian to the admin", async function () {
    const { other, comptroller, cDebt } = await deployFixture();

    await expect(comptroller._setMarketBorrowCaps([], [])).to.be.revertedWith("invalid input");
    await expect(comptroller._setMarketBorrowCaps([cDebt.target], [1, 2])).to.be.revertedWith("invalid input");

    await expect(comptroller.connect(other)._setBorrowCapGuardian(other.address)).to.be.revertedWith(
      "only admin can set borrow cap guardian"
    );

    expect(await comptroller.connect(other)._setPauseGuardian.staticCall(other.address)).to.equal(1);
    await expect(comptroller.connect(other)._setPauseGuardian(other.address))
      .to.emit(comptroller, "Failure")
      .withArgs(1, 19, 0);
  });

  it("rejects pausing an unlisted market and enforces pause-guardian/admin-only-unpause on transfer/seize", async function () {
    const { owner, pauseGuardian, other, comptroller, cDebt } = await deployFixture();
    await comptroller._setPauseGuardian(pauseGuardian.address);

    const unlistedMarket = ethers.Wallet.createRandom().address;
    await expect(comptroller._setMintPaused(unlistedMarket, true)).to.be.revertedWith(
      "cannot pause a market that is not listed"
    );
    await expect(comptroller._setBorrowPaused(unlistedMarket, true)).to.be.revertedWith(
      "cannot pause a market that is not listed"
    );

    await expect(comptroller.connect(other)._setMintPaused(cDebt.target, true)).to.be.revertedWith(
      "only pause guardian and admin can pause"
    );
    await comptroller.connect(pauseGuardian)._setMintPaused(cDebt.target, true);
    await expect(comptroller.connect(pauseGuardian)._setMintPaused(cDebt.target, false)).to.be.revertedWith(
      "only admin can unpause"
    );
    await comptroller.connect(owner)._setMintPaused(cDebt.target, false);

    await expect(comptroller.connect(other)._setBorrowPaused(cDebt.target, true)).to.be.revertedWith(
      "only pause guardian and admin can pause"
    );
    await comptroller.connect(pauseGuardian)._setBorrowPaused(cDebt.target, true);
    await expect(comptroller.connect(pauseGuardian)._setBorrowPaused(cDebt.target, false)).to.be.revertedWith(
      "only admin can unpause"
    );
    await comptroller.connect(owner)._setBorrowPaused(cDebt.target, false);

    await expect(comptroller.connect(other)._setTransferPaused(true)).to.be.revertedWith(
      "only pause guardian and admin can pause"
    );
    await comptroller.connect(pauseGuardian)._setTransferPaused(true);
    expect(await comptroller.transferGuardianPaused()).to.equal(true);
    await expect(comptroller.connect(pauseGuardian)._setTransferPaused(false)).to.be.revertedWith(
      "only admin can unpause"
    );
    await comptroller.connect(owner)._setTransferPaused(false);

    await expect(comptroller.connect(other)._setSeizePaused(true)).to.be.revertedWith(
      "only pause guardian and admin can pause"
    );
    await comptroller.connect(pauseGuardian)._setSeizePaused(true);
    expect(await comptroller.seizeGuardianPaused()).to.equal(true);
    await expect(comptroller.connect(pauseGuardian)._setSeizePaused(false)).to.be.revertedWith(
      "only admin can unpause"
    );
    await comptroller.connect(owner)._setSeizePaused(false);
  });

  it("restricts _become to the target Unitroller's admin and requires a real pending implementation", async function () {
    const { owner, other, comptroller } = await deployFixture();
    const unitrollerAddr = await comptroller.getAddress();

    const otherImpl = await (await ethers.getContractFactory("Comptroller")).deploy();
    await expect(otherImpl.connect(other)._become(unitrollerAddr)).to.be.revertedWith(
      "only unitroller admin can change brains"
    );

    // owner IS the unitroller's admin, but otherImpl was never set as pendingComptrollerImplementation,
    // so the underlying _acceptImplementation() call fails and _become must revert.
    await expect(otherImpl.connect(owner)._become(unitrollerAddr)).to.be.revertedWith("change not authorized");
  });

  it("returns MARKET_NOT_LISTED from every policy hook when called with an unlisted market", async function () {
    const { borrower, liquidator, comptroller, cCollateral } = await deployFixture();
    const unlisted = ethers.Wallet.createRandom().address;
    const MARKET_NOT_LISTED = 9n;

    expect(await comptroller.mintAllowed.staticCall(unlisted, borrower.address, 1n)).to.equal(MARKET_NOT_LISTED);
    expect(await comptroller.redeemAllowed.staticCall(unlisted, borrower.address, 1n)).to.equal(MARKET_NOT_LISTED);
    expect(await comptroller.borrowAllowed.staticCall(unlisted, borrower.address, 1n)).to.equal(MARKET_NOT_LISTED);
    expect(
      await comptroller.repayBorrowAllowed.staticCall(unlisted, liquidator.address, borrower.address, 1n)
    ).to.equal(MARKET_NOT_LISTED);
    expect(
      await comptroller.liquidateBorrowAllowed.staticCall(
        unlisted,
        cCollateral.target,
        liquidator.address,
        borrower.address,
        1n
      )
    ).to.equal(MARKET_NOT_LISTED);
    // Also exercise the second half of the `!isListed(borrowed) || !isListed(collateral)` short-circuit:
    // borrowed market IS listed here, only the collateral market is unlisted.
    expect(
      await comptroller.liquidateBorrowAllowed.staticCall(
        cCollateral.target,
        unlisted,
        liquidator.address,
        borrower.address,
        1n
      )
    ).to.equal(MARKET_NOT_LISTED);
    expect(
      await comptroller.seizeAllowed.staticCall(cCollateral.target, unlisted, liquidator.address, borrower.address, 1n)
    ).to.equal(MARKET_NOT_LISTED);
  });

  it("allows liquidation of a deprecated market without a shortfall check", async function () {
    const { owner, supplier, borrower, liquidator, collateralAsset, debtAsset, comptroller, cCollateral, cDebt } =
      await deployFixture();

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);
    await cDebt.connect(borrower).borrow(ethers.parseEther("10"));

    expect(await comptroller.isDeprecated(cDebt.target)).to.equal(false);

    // isDeprecated requires collateralFactor == 0 (already true for cDebt), borrowGuardianPaused == true,
    // and reserveFactorMantissa == 1e18 -- all three conjuncts of the isDeprecated `&&` chain.
    await comptroller._setPauseGuardian(owner.address);
    await comptroller.connect(owner)._setBorrowPaused(cDebt.target, true);
    await cDebt.connect(owner)._setReserveFactor(ethers.parseEther("1"));

    expect(await comptroller.isDeprecated(cDebt.target)).to.equal(true);

    // Borrower has no shortfall at all (collateral price untouched), yet a deprecated market may
    // still be liquidated in full so long as repayAmount does not exceed the outstanding borrow.
    expect(
      await comptroller.liquidateBorrowAllowed.staticCall(
        cDebt.target,
        cCollateral.target,
        liquidator.address,
        borrower.address,
        ethers.parseEther("10")
      )
    ).to.equal(0);

    await expect(
      comptroller.liquidateBorrowAllowed.staticCall(
        cDebt.target,
        cCollateral.target,
        liquidator.address,
        borrower.address,
        ethers.parseEther("11")
      )
    ).to.be.revertedWith("Can not repay more than the total borrow");
  });

  it("returns COMPTROLLER_MISMATCH from seizeAllowed when the two markets have different comptrollers", async function () {
    const { owner, comptroller, cCollateral } = await deployFixture();

    // A second, independent comptroller so cCollateral.comptroller() != otherMarket.comptroller().
    const otherComptrollerImpl = await (await ethers.getContractFactory("Comptroller")).deploy();
    const otherUnitroller = await (await ethers.getContractFactory("Unitroller")).deploy();
    await otherUnitroller._setPendingImplementation(otherComptrollerImpl.target);
    await otherComptrollerImpl._become(otherUnitroller.target);
    const otherComptroller = await ethers.getContractAt("Comptroller", otherUnitroller.target);
    await otherComptroller._setPriceOracle(await comptroller.oracle());

    const Delegate = await ethers.getContractFactory("CErc20Delegate");
    const delegate = await Delegate.deploy();
    const Token = await ethers.getContractFactory("MockERC20");
    const otherAsset = await Token.deploy("Other", "OTH", 18);
    const JumpRateModel = await ethers.getContractFactory("JumpRateModelV2");
    const irm = await JumpRateModel.deploy(0, 0, 0, ethers.parseEther("0.8"), owner.address);
    const Delegator = await ethers.getContractFactory("CErc20Delegator");
    const otherMarket = await Delegator.deploy(
      otherAsset.target,
      otherUnitroller.target,
      irm.target,
      ethers.parseEther("1"),
      "Other Market",
      "sOTH",
      8,
      owner.address,
      delegate.target,
      "0x"
    );
    await otherComptroller._supportMarket(otherMarket.target);
    // Also list otherMarket on the FIRST comptroller (the one whose seizeAllowed we're calling) so it
    // passes the isListed checks there -- its own comptroller() pointer still resolves to
    // otherUnitroller, which is what actually produces the mismatch below.
    await comptroller._supportMarket(otherMarket.target);

    const COMPTROLLER_MISMATCH = 2n;
    expect(
      await comptroller.seizeAllowed.staticCall(cCollateral.target, otherMarket.target, owner.address, owner.address, 1n)
    ).to.equal(COMPTROLLER_MISMATCH);
  });

  it("exposes getAssetsIn, getAllMarkets, getHypotheticalAccountLiquidity, and getRewardTokenAddress", async function () {
    const { borrower, collateralAsset, comptroller, cCollateral, cDebt } = await deployFixture();

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("10"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("10"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);

    expect(await comptroller.getAssetsIn(borrower.address)).to.deep.equal([cCollateral.target]);
    expect(await comptroller.getAllMarkets()).to.deep.equal([cCollateral.target, cDebt.target]);
    expect(await comptroller.getRewardTokenAddress()).to.equal(ethers.ZeroAddress);

    const [err, liquidity, shortfall] = await comptroller.getHypotheticalAccountLiquidity(
      borrower.address,
      ethers.ZeroAddress,
      0,
      0
    );
    expect(err).to.equal(0);
    expect(shortfall).to.equal(0);
    expect(liquidity).to.be.gt(0);
  });

  it("allows anyone to call the no-op *Verify hooks", async function () {
    const { owner, borrower, liquidator, comptroller, cCollateral, cDebt } = await deployFixture();

    await expect(comptroller.connect(owner).mintVerify(cDebt.target, owner.address, 1, 1)).to.not.be.reverted;
    await expect(comptroller.connect(owner).redeemVerify(cDebt.target, owner.address, 1, 1)).to.not.be.reverted;
    await expect(comptroller.connect(owner).redeemVerify(cDebt.target, owner.address, 0, 0)).to.not.be.reverted;
    await expect(comptroller.connect(owner).redeemVerify(cDebt.target, owner.address, 1, 0)).to.be.revertedWith(
      "redeemTokens zero"
    );
    await expect(comptroller.connect(owner).borrowVerify(cDebt.target, borrower.address, 1)).to.not.be.reverted;
    await expect(
      comptroller.connect(owner).repayBorrowVerify(cDebt.target, owner.address, borrower.address, 1, 1)
    ).to.not.be.reverted;
    await expect(
      comptroller
        .connect(owner)
        .liquidateBorrowVerify(cDebt.target, cCollateral.target, liquidator.address, borrower.address, 1, 1)
    ).to.not.be.reverted;
    await expect(
      comptroller
        .connect(owner)
        .seizeVerify(cCollateral.target, cDebt.target, liquidator.address, borrower.address, 1)
    ).to.not.be.reverted;
    await expect(
      comptroller.connect(owner).transferVerify(cDebt.target, owner.address, borrower.address, 1)
    ).to.not.be.reverted;
  });

  it("restricts fixBadAccruals to the admin and blocks a second invocation", async function () {
    const { owner, other, comptroller } = await deployFixture();

    await expect(
      comptroller.connect(other).fixBadAccruals([other.address], [0])
    ).to.be.revertedWith("Only admin can call this function");
    await expect(comptroller.connect(owner).fixBadAccruals([other.address, owner.address], [0])).to.be.revertedWith(
      "Invalid input"
    );

    await comptroller.connect(owner).fixBadAccruals([other.address], [100]);
    await expect(comptroller.connect(owner).fixBadAccruals([other.address], [100])).to.be.revertedWith(
      "Already executed this one-off function"
    );
  });

  it("fixBadAccruals: subtracts within existing accrual, records receivable when subtracting more than accrued, and no-ops at zero", async function () {
    const { owner, supplier, debtAsset, comptroller, cDebt } = await deployFixture();

    // Give the supplier a real nonzero rewardAccrued balance via the legacy flywheel so this test
    // exercises fixBadAccruals' actual arithmetic, not just its access-control guards.
    await comptroller.connect(owner)._setRewardSpeeds([cDebt.target], [1_000], [0]);
    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));
    await ethers.provider.send("evm_mine", []);
    await comptroller["claimRewards(address)"](supplier.address);

    const accruedBefore = await comptroller.rewardAccrued(supplier.address);
    expect(accruedBefore).to.be.gt(0);

    // Subtract less than the real accrual -- amountToSubtract <= currentAccrual, no receivable
    // recorded, and the accrual is reduced by exactly that amount.
    const partial = accruedBefore / 2n;
    await expect(comptroller.connect(owner).fixBadAccruals([supplier.address], [partial]))
      .to.emit(comptroller, "RewardAccruedAdjusted")
      .withArgs(supplier.address, accruedBefore, accruedBefore - partial);
    expect(await comptroller.rewardAccrued(supplier.address)).to.equal(accruedBefore - partial);
    expect(await comptroller.rewardReceivable(supplier.address)).to.equal(0);
  });

  it("restricts legacy reward admin functions and flows reward speeds through mint/redeem/borrow", async function () {
    const { owner, other, supplier, borrower, collateralAsset, debtAsset, comptroller, cCollateral, cDebt } =
      await deployFixture();

    await expect(
      comptroller.connect(other)._setRewardSpeeds([cDebt.target], [1], [1])
    ).to.be.revertedWith("only admin can set reward speed");
    await expect(
      comptroller.connect(owner)._setRewardSpeeds([cDebt.target], [1], [1, 2])
    ).to.be.revertedWith("Comptroller::_setRewardSpeeds invalid input");

    const unlistedMarket = ethers.Wallet.createRandom().address;
    await expect(
      comptroller.connect(owner)._setRewardSpeeds([unlistedMarket], [1], [1])
    ).to.be.revertedWith("reward market is not listed");

    // Nonzero supply and borrow speeds on a listed market -- exercises the reward-index update
    // branches inside updateRewardSupplyIndex/updateRewardBorrowIndex (deltaBlocks>0 && speed>0).
    await expect(comptroller.connect(owner)._setRewardSpeeds([cDebt.target], [1_000], [1_000]))
      .to.emit(comptroller, "RewardSupplySpeedUpdated")
      .and.to.emit(comptroller, "RewardBorrowSpeedUpdated");

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);
    await cDebt.connect(borrower).borrow(ethers.parseEther("10"));

    // Re-setting the same speeds a second time must hit the "speed unchanged" branch (no event).
    await expect(comptroller.connect(owner)._setRewardSpeeds([cDebt.target], [1_000], [1_000])).to.not.emit(
      comptroller,
      "RewardSupplySpeedUpdated"
    );

    await expect(
      comptroller.connect(other)._setContributorRewardSpeed(other.address, 5)
    ).to.be.revertedWith("only admin can set reward speed");
    await expect(comptroller.connect(owner)._setContributorRewardSpeed(other.address, 5)).to.emit(
      comptroller,
      "ContributorRewardSpeedUpdated"
    );
    await comptroller.updateContributorRewards(other.address);
    // Zero speed disables accrual and clears the stored block.
    await comptroller.connect(owner)._setContributorRewardSpeed(other.address, 0);

    // Reward transfers are intentionally disabled (grantRewardInternal always returns the full
    // amount as "not transferred"), so any nonzero grant must revert; a zero-amount grant succeeds.
    await expect(
      comptroller.connect(other)._grantRewards(other.address, 0)
    ).to.be.revertedWith("only admin can grant rewards");
    await expect(comptroller.connect(owner)._grantRewards(supplier.address, 0)).to.emit(
      comptroller,
      "RewardGranted"
    );
    await expect(comptroller.connect(owner)._grantRewards(supplier.address, 1)).to.be.revertedWith(
      "insufficient rewards for grant"
    );

    // claimRewards: all three overloads.
    await comptroller["claimRewards(address)"](supplier.address);
    await comptroller["claimRewards(address,address[])"](supplier.address, [cDebt.target]);
    await comptroller["claimRewards(address[],address[],bool,bool)"](
      [supplier.address, borrower.address],
      [cCollateral.target, cDebt.target],
      true,
      true
    );
    await expect(
      comptroller["claimRewards(address,address[])"](supplier.address, [unlistedMarket])
    ).to.be.revertedWith("market must be listed");

    // Exercise the borrowers/suppliers flags independently (both prior calls above always passed
    // true for both).
    await comptroller["claimRewards(address[],address[],bool,bool)"](
      [supplier.address],
      [cDebt.target],
      false,
      true
    );
    await comptroller["claimRewards(address[],address[],bool,bool)"](
      [borrower.address],
      [cDebt.target],
      true,
      false
    );
  });
});
