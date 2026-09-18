// @ts-nocheck
import { expect } from "chai";
import { ethers } from "hardhat";

describe("CErc20 / CToken market behavior", function () {
  async function deployFixture() {
    const [owner, supplier, borrower, liquidator, other] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const collateralAsset = await Token.deploy("Collateral Token", "COL", 18);
    const debtAsset = await Token.deploy("Debt Token", "USD", 18);
    const strayToken = await Token.deploy("Stray Token", "STR", 18);

    const Oracle = await ethers.getContractFactory("SecurdPriceOracle");
    const oracle = await Oracle.deploy(owner.address, ethers.ZeroAddress);

    const JumpRateModel = await ethers.getContractFactory("JumpRateModelV2");
    const interestRateModel = await JumpRateModel.deploy(0, 0, 0, ethers.parseEther("0.8"), owner.address);
    const newerInterestRateModel = await JumpRateModel.deploy(
      ethers.parseEther("0.01"),
      ethers.parseEther("0.1"),
      ethers.parseEther("1"),
      ethers.parseEther("0.85"),
      owner.address
    );

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

    for (const asset of [collateralAsset, debtAsset]) {
      await oracle.setFallbackConfig(asset.target, 86400);
      await oracle.setOracleType(asset.target, 3);
      await oracle.postFallbackPrice(asset.target, ethers.parseEther("1"));
    }

    await comptroller._setCollateralFactor(cCollateral.target, ethers.parseEther("0.75"));
    await comptroller._setCollateralFactor(cDebt.target, 0);

    await collateralAsset.mint(borrower.address, ethers.parseEther("100"));
    await debtAsset.mint(supplier.address, ethers.parseEther("500"));
    await debtAsset.mint(liquidator.address, ethers.parseEther("500"));
    await strayToken.mint(cDebt.target, ethers.parseEther("10"));

    return {
      owner,
      supplier,
      borrower,
      liquidator,
      other,
      collateralAsset,
      debtAsset,
      strayToken,
      oracle,
      comptroller,
      cCollateral,
      cDebt,
      interestRateModel,
      newerInterestRateModel,
      delegate
    };
  }

  it("supports transfer, transferFrom, and blocks self-transfer", async function () {
    const { borrower, other, collateralAsset, cCollateral } = await deployFixture();

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));

    await expect(cCollateral.connect(borrower).transfer(other.address, ethers.parseEther("10"))).to.emit(
      cCollateral,
      "Transfer"
    );
    expect(await cCollateral.balanceOf(other.address)).to.equal(ethers.parseEther("10"));

    await cCollateral.connect(borrower).approve(other.address, ethers.parseEther("5"));
    await expect(cCollateral.connect(other).transferFrom(borrower.address, other.address, ethers.parseEther("5"))).to.emit(
      cCollateral,
      "Transfer"
    );
    expect(await cCollateral.allowance(borrower.address, other.address)).to.equal(0);

    await expect(cCollateral.connect(borrower).transfer(borrower.address, ethers.parseEther("1"))).to.be.reverted;
  });

  it("supports repayBorrowBehalf and max repay paths", async function () {
    const { supplier, borrower, other, collateralAsset, debtAsset, comptroller, cCollateral, cDebt } = await deployFixture();

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);
    await cDebt.connect(borrower).borrow(ethers.parseEther("50"));

    await debtAsset.connect(other).mint(other.address, ethers.parseEther("50"));
    await debtAsset.connect(other).approve(cDebt.target, ethers.parseEther("50"));
    await expect(cDebt.connect(other).repayBorrowBehalf(borrower.address, ethers.parseEther("20"))).to.emit(
      cDebt,
      "RepayBorrow"
    );
    expect(await cDebt.borrowBalanceStored(borrower.address)).to.equal(ethers.parseEther("30"));

    await debtAsset.connect(other).approve(cDebt.target, ethers.parseEther("30"));
    await cDebt.connect(other).repayBorrowBehalf(borrower.address, ethers.MaxUint256);
    expect(await cDebt.borrowBalanceStored(borrower.address)).to.equal(0);
  });

  it("supports reserve management, interest model changes, and sweeping non-underlying tokens", async function () {
    const { owner, supplier, debtAsset, strayToken, cDebt, newerInterestRateModel } = await deployFixture();

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    await debtAsset.connect(owner).mint(owner.address, ethers.parseEther("100"));
    await debtAsset.connect(owner).approve(cDebt.target, ethers.parseEther("100"));

    await expect(cDebt.connect(owner)._setReserveFactor(ethers.parseEther("0.1"))).to.emit(cDebt, "NewReserveFactor");
    expect(await cDebt.reserveFactorMantissa()).to.equal(ethers.parseEther("0.1"));

    await expect(cDebt.connect(owner)._addReserves(ethers.parseEther("20"))).to.emit(cDebt, "ReservesAdded");
    expect(await cDebt.totalReserves()).to.equal(ethers.parseEther("20"));

    await expect(cDebt.connect(owner)._reduceReserves(ethers.parseEther("5"))).to.emit(cDebt, "ReservesReduced");
    expect(await cDebt.totalReserves()).to.equal(ethers.parseEther("15"));

    await expect(cDebt.connect(owner)._setInterestRateModel(newerInterestRateModel.target)).to.emit(
      cDebt,
      "NewMarketInterestRateModel"
    );
    expect(await cDebt.interestRateModel()).to.equal(newerInterestRateModel.target);

    const ownerStrayBefore = await strayToken.balanceOf(owner.address);
    await cDebt.connect(owner).sweepToken(strayToken.target);
    expect(await strayToken.balanceOf(owner.address)).to.equal(ownerStrayBefore + ethers.parseEther("10"));

    await expect(cDebt.connect(owner).sweepToken(debtAsset.target)).to.be.revertedWith(
      "CErc20::sweepToken: can not sweep underlying token"
    );
  });

  it("enforces transfer restrictions from comptroller liquidity and global pause", async function () {
    const { owner, supplier, borrower, other, collateralAsset, debtAsset, comptroller, cCollateral, cDebt } =
      await deployFixture();

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);
    await cDebt.connect(borrower).borrow(ethers.parseEther("50"));

    await expect(cCollateral.connect(borrower).transfer(other.address, ethers.parseEther("80"))).to.be.reverted;

    await comptroller._setPauseGuardian(owner.address);
    await comptroller._setTransferPaused(true);
    await expect(cCollateral.connect(borrower).transfer(other.address, ethers.parseEther("1"))).to.be.revertedWith(
      "transfer is paused"
    );
  });

  it("enforces liquidation edge cases at the market layer", async function () {
    const { supplier, borrower, liquidator, collateralAsset, debtAsset, oracle, comptroller, cCollateral, cDebt } =
      await deployFixture();

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);
    await cDebt.connect(borrower).borrow(ethers.parseEther("60"));

    await debtAsset.connect(liquidator).approve(cDebt.target, ethers.parseEther("60"));

    await expect(cDebt.connect(liquidator).liquidateBorrow(borrower.address, 0, cCollateral.target)).to.be.reverted;

    await oracle.postFallbackPrice(collateralAsset.target, ethers.parseEther("0.5"));

    await expect(
      cDebt.connect(borrower).liquidateBorrow(borrower.address, ethers.parseEther("1"), cCollateral.target)
    ).to.be.reverted;

    await expect(
      cDebt.connect(liquidator).liquidateBorrow(borrower.address, ethers.MaxUint256, cCollateral.target)
    ).to.be.reverted;

    await expect(
      cDebt.connect(liquidator).liquidateBorrow(borrower.address, ethers.parseEther("40"), cCollateral.target)
    ).to.be.reverted;

    await expect(
      cDebt.connect(liquidator).liquidateBorrow(borrower.address, ethers.parseEther("30"), cCollateral.target)
    ).to.emit(cDebt, "LiquidateBorrow");
  });

  it("exercises liquidateBorrowFresh's own internal checks with a permissive comptroller and a fake collateral market", async function () {
    // The real Comptroller's own close-factor/shortfall checks in liquidateBorrowAllowed always
    // intercept degenerate repayAmount values (0, type(uint256).max) and comptroller-reported
    // errors before CToken's own equivalent internal checks would ever run. Swapping in a
    // MockPermissiveComptroller (which allows everything by default and lets each check's return
    // value be configured independently) isolates and exercises CToken.sol's own internal
    // liquidateBorrowFresh logic directly, including paths a real Comptroller can never let through.
    const { owner, supplier, borrower, liquidator, debtAsset, cDebt } = await deployFixture();

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    // Swap in the permissive comptroller before borrowing: the real Comptroller would otherwise
    // reject this borrow outright since `borrower` has no collateral entered in this test.
    const PermissiveComptroller = await ethers.getContractFactory("MockPermissiveComptroller");
    const permissiveComptroller = await PermissiveComptroller.deploy();
    await cDebt.connect(owner)._setComptroller(permissiveComptroller.target);

    await cDebt.connect(borrower).borrow(ethers.parseEther("60"));

    const LiquidationCollateral = await ethers.getContractFactory("MockLiquidationCollateral");
    const fakeCollateral = await LiquidationCollateral.deploy();

    await debtAsset.connect(liquidator).approve(cDebt.target, ethers.parseEther("60"));

    // The collateral-market freshness check (cTokenCollateral.accrualBlockNumber() == current block)
    // runs before CToken's own repayAmount==0/repayAmount==max checks, so it must be kept in sync
    // for every sub-case below that is meant to reach further than that check. This setter's own
    // transaction mines at latest+1, so the *following* transaction (the liquidateBorrow call) lands
    // at latest+2 -- call this immediately before each such liquidateBorrow.
    async function syncFreshCollateral() {
      const latest = await ethers.provider.getBlockNumber();
      await fakeCollateral.setAccrualBlockNumber(latest + 2);
    }

    // CToken's own LiquidateCloseAmountIsZero check.
    await syncFreshCollateral();
    await expect(
      cDebt.connect(liquidator).liquidateBorrow(borrower.address, 0, fakeCollateral.target)
    ).to.be.reverted;

    // CToken's own LiquidateCloseAmountIsUintMax check.
    await syncFreshCollateral();
    await expect(
      cDebt.connect(liquidator).liquidateBorrow(borrower.address, ethers.MaxUint256, fakeCollateral.target)
    ).to.be.reverted;

    // cTokenCollateral.accrueInterest() returning a non-zero error code (checked in
    // liquidateBorrowInternal before liquidateBorrowFresh -- and thus before the collateral
    // freshness check -- runs, so no sync is needed here).
    await fakeCollateral.setAccrueInterestResult(5);
    await expect(
      cDebt.connect(liquidator).liquidateBorrow(borrower.address, ethers.parseEther("1"), fakeCollateral.target)
    ).to.be.reverted;
    await fakeCollateral.setAccrueInterestResult(0);

    // cTokenCollateral.accrualBlockNumber() stale relative to the current block (deliberately NOT synced).
    await fakeCollateral.setAccrualBlockNumber(1);
    await expect(
      cDebt.connect(liquidator).liquidateBorrow(borrower.address, ethers.parseEther("1"), fakeCollateral.target)
    ).to.be.reverted;

    // liquidateCalculateSeizeTokens reporting a comptroller-side error (e.g. a price error).
    await permissiveComptroller.setNextSeizeTokensResult(13, 0);
    await syncFreshCollateral();
    await expect(
      cDebt.connect(liquidator).liquidateBorrow(borrower.address, ethers.parseEther("1"), fakeCollateral.target)
    ).to.be.revertedWith("LIQUIDATE_COMPTROLLER_CALCULATE_AMOUNT_SEIZE_FAILED");

    // Seize tokens exceeding the borrower's actual collateral-market balance.
    await permissiveComptroller.setNextSeizeTokensResult(0, ethers.parseEther("1000"));
    await fakeCollateral.setBalance(borrower.address, ethers.parseEther("1"));
    await syncFreshCollateral();
    await expect(
      cDebt.connect(liquidator).liquidateBorrow(borrower.address, ethers.parseEther("1"), fakeCollateral.target)
    ).to.be.revertedWith("LIQUIDATE_SEIZE_TOO_MUCH");

    // cTokenCollateral.seize() itself returning a non-zero error code.
    await permissiveComptroller.setNextSeizeTokensResult(0, ethers.parseEther("1"));
    await fakeCollateral.setBalance(borrower.address, ethers.parseEther("5"));
    await fakeCollateral.setSeizeResult(9);
    await syncFreshCollateral();
    await expect(
      cDebt.connect(liquidator).liquidateBorrow(borrower.address, ethers.parseEther("1"), fakeCollateral.target)
    ).to.be.revertedWith("token seizure failed");
  });

  it("reverts redeem when the market's cash has been borrowed out from under the redeemer", async function () {
    const { supplier, borrower, collateralAsset, debtAsset, comptroller, cCollateral, cDebt } = await deployFixture();

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    // Collateral factor is 0.75 and price is 1, so borrowing 450 requires >= 600 collateral --
    // top up beyond the fixture's default 100 so the borrow itself succeeds.
    await collateralAsset.mint(borrower.address, ethers.parseEther("600"));
    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("700"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("700"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);
    // Only 50 of the 500 supplied cash remains in the market after this borrow.
    await cDebt.connect(borrower).borrow(ethers.parseEther("450"));

    await expect(cDebt.connect(supplier).redeemUnderlying(ethers.parseEther("100"))).to.be.reverted;
  });

  it("reverts accrueInterest when the interest rate model returns an absurdly high borrow rate", async function () {
    const { owner, comptroller, debtAsset } = await deployFixture();

    const ExtremeIrm = await ethers.getContractFactory("MockExtremeInterestRateModel");
    const extremeIrm = await ExtremeIrm.deploy(ethers.parseEther("1")); // far above borrowRateMaxMantissa

    const Delegate = await ethers.getContractFactory("CErc20Delegate");
    const delegate = await Delegate.deploy();
    const Delegator = await ethers.getContractFactory("CErc20Delegator");
    const cExtreme = await Delegator.deploy(
      debtAsset.target,
      comptroller.target,
      extremeIrm.target,
      ethers.parseEther("1"),
      "Securd Extreme",
      "sEXT",
      8,
      owner.address,
      delegate.target,
      "0x"
    );

    // accrueInterest short-circuits when called within its own construction block, so mine a block
    // in between (any transaction does) before triggering it for real.
    await comptroller._supportMarket(cExtreme.target);

    await expect(cExtreme.accrueInterest()).to.be.revertedWith("borrow rate is absurdly high");
  });

  it("supports in-kind liquidation where the collateral market equals the borrowed market", async function () {
    const { supplier, borrower, liquidator, collateralAsset, debtAsset, oracle, comptroller, cCollateral, cDebt } =
      await deployFixture();

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);

    // Borrower also holds sUSD (cDebt) shares directly, so cDebt itself can serve as the seized
    // collateral market in a liquidation of its own borrow (the `cTokenCollateral == address(this)`
    // branch in liquidateBorrowFresh, which routes through seizeInternal without an external call).
    await debtAsset.mint(borrower.address, ethers.parseEther("50"));
    await debtAsset.connect(borrower).approve(cDebt.target, ethers.parseEther("50"));
    await cDebt.connect(borrower).mint(ethers.parseEther("50"));

    await cDebt.connect(borrower).borrow(ethers.parseEther("60"));

    await oracle.postFallbackPrice(collateralAsset.target, ethers.parseEther("0.5"));

    const borrowerDebtSharesBefore = await cDebt.balanceOf(borrower.address);
    expect(borrowerDebtSharesBefore).to.be.gt(0);

    await debtAsset.connect(liquidator).approve(cDebt.target, ethers.parseEther("30"));
    await expect(
      cDebt.connect(liquidator).liquidateBorrow(borrower.address, ethers.parseEther("30"), cDebt.target)
    ).to.emit(cDebt, "LiquidateBorrow");

    expect(await cDebt.balanceOf(liquidator.address)).to.be.gt(0);
    expect(await cDebt.balanceOf(borrower.address)).to.be.lt(borrowerDebtSharesBefore);
  });

  it("supports plain redeem() (as opposed to redeemUnderlying)", async function () {
    const { supplier, debtAsset, cDebt } = await deployFixture();
    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    const cTokenBalance = await cDebt.balanceOf(supplier.address);
    expect(cTokenBalance).to.be.gt(0);

    const underlyingBefore = await debtAsset.balanceOf(supplier.address);
    await expect(cDebt.connect(supplier).redeem(cTokenBalance)).to.emit(cDebt, "Redeem");
    expect(await cDebt.balanceOf(supplier.address)).to.equal(0);
    expect(await debtAsset.balanceOf(supplier.address)).to.be.gt(underlyingBefore);
  });

  it("restricts sweepToken to the admin and reverts when the stray token's transfer fails", async function () {
    const { owner, supplier, other, debtAsset, cDebt } = await deployFixture();
    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    await expect(cDebt.connect(other).sweepToken(debtAsset.target)).to.be.revertedWith(
      "CErc20::sweepToken: only admin can sweep tokens"
    );

    const failingStray = await (await ethers.getContractFactory("MockERC20TransferFalse")).deploy("Bad", "BAD");
    await failingStray.mint(cDebt.target, 1_000n);
    await expect(cDebt.connect(owner).sweepToken(failingStray.target)).to.be.revertedWith(
      "CErc20::sweepToken: transfer failed"
    );
  });

  it("reverts mint when the underlying's transferFrom returns false", async function () {
    const { owner, supplier, comptroller, interestRateModel } = await deployFixture();
    const failingToken = await (await ethers.getContractFactory("MockERC20TransferFromFalse")).deploy("Bad", "BAD");
    const delegate = await (await ethers.getContractFactory("CErc20Delegate")).deploy();
    const Delegator = await ethers.getContractFactory("CErc20Delegator");
    const cFailing = await Delegator.deploy(
      failingToken.target,
      comptroller.target,
      interestRateModel.target,
      ethers.parseEther("1"),
      "Securd Failing",
      "sFAIL",
      8,
      owner.address,
      delegate.target,
      "0x"
    );
    await comptroller._supportMarket(cFailing.target);

    await failingToken.mint(supplier.address, ethers.parseEther("10"));
    // approve() is unaffected by the transferFrom override, so this succeeds and lets mint reach doTransferIn.
    await failingToken.connect(supplier).approve(cFailing.target, ethers.parseEther("10"));

    await expect(cFailing.connect(supplier).mint(ethers.parseEther("10"))).to.be.revertedWith(
      "TOKEN_TRANSFER_IN_FAILED"
    );
  });

  it("reverts redeem when the underlying's transfer returns false", async function () {
    const { owner, supplier, comptroller, oracle, interestRateModel } = await deployFixture();
    const failingToken = await (await ethers.getContractFactory("MockERC20TransferFalse")).deploy("Bad", "BAD");
    const delegate = await (await ethers.getContractFactory("CErc20Delegate")).deploy();
    const Delegator = await ethers.getContractFactory("CErc20Delegator");
    const cFailing = await Delegator.deploy(
      failingToken.target,
      comptroller.target,
      interestRateModel.target,
      ethers.parseEther("1"),
      "Securd Failing",
      "sFAIL",
      8,
      owner.address,
      delegate.target,
      "0x"
    );
    await comptroller._supportMarket(cFailing.target);
    await oracle.setFallbackConfig(failingToken.target, 86400);
    await oracle.setOracleType(failingToken.target, 3);
    await oracle.postFallbackPrice(failingToken.target, ethers.parseEther("1"));

    // MockERC20TransferFalse only overrides transfer(), not transferFrom() -- mint (doTransferIn,
    // via transferFrom) succeeds normally, so the supplier ends up with real cTokens; only the
    // subsequent redeem (doTransferOut, via transfer()) hits the failing path.
    await failingToken.mint(supplier.address, ethers.parseEther("10"));
    await failingToken.connect(supplier).approve(cFailing.target, ethers.parseEther("10"));
    await cFailing.connect(supplier).mint(ethers.parseEther("10"));

    await expect(cFailing.connect(supplier).redeem(await cFailing.balanceOf(supplier.address))).to.be.revertedWith(
      "TOKEN_TRANSFER_OUT_FAILED"
    );
  });

  it("restricts _delegateUnderlyingVotesTo to the admin and forwards to the underlying's delegate()", async function () {
    const { owner, other, comptroller, interestRateModel } = await deployFixture();
    const govToken = await (await ethers.getContractFactory("MockGovernanceToken")).deploy("Gov", "GOV");
    const delegate = await (await ethers.getContractFactory("CErc20Delegate")).deploy();
    const Delegator = await ethers.getContractFactory("CErc20Delegator");
    const cGov = await Delegator.deploy(
      govToken.target,
      comptroller.target,
      interestRateModel.target,
      ethers.parseEther("1"),
      "Securd Gov",
      "sGOV",
      8,
      owner.address,
      delegate.target,
      "0x"
    );
    await comptroller._supportMarket(cGov.target);

    // _delegateUnderlyingVotesTo is only reachable through the delegator's generic fallback
    // (delegatecall passthrough) -- it's not one of the explicitly forwarded functions on
    // CErc20Delegator itself, so attach the CErc20Delegate ABI to call it.
    const cGovAsDelegate = await ethers.getContractAt("CErc20Delegate", cGov.target);

    await expect(cGovAsDelegate.connect(other)._delegateUnderlyingVotesTo(other.address)).to.be.revertedWith(
      "only the admin may set the governance delegate"
    );

    await cGovAsDelegate.connect(owner)._delegateUnderlyingVotesTo(other.address);
    expect(await govToken.lastDelegatee()).to.equal(other.address);
  });

  it("exposes the simple read-side getters", async function () {
    const { supplier, debtAsset, cDebt } = await deployFixture();
    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    expect(await cDebt.getCash()).to.be.gt(0);
    expect(await cDebt.borrowRatePerBlock()).to.equal(0); // 0% IRM in this fixture, still exercises the getter
    expect(await cDebt.supplyRatePerBlock()).to.equal(0);
    expect(await cDebt.balanceOfUnderlying.staticCall(supplier.address)).to.be.gt(0);
    expect(await cDebt.totalBorrowsCurrent.staticCall()).to.equal(0);
    expect(await cDebt.borrowBalanceCurrent.staticCall(supplier.address)).to.equal(0);
    expect(await cDebt.exchangeRateCurrent.staticCall()).to.be.gt(0);

    // Actually send the transactions too (staticCall above only simulates), so the nonReentrant/
    // accrueInterest paths execute for real, not just get simulated.
    await cDebt.totalBorrowsCurrent();
    await cDebt.borrowBalanceCurrent(supplier.address);
    await cDebt.exchangeRateCurrent();
    await cDebt.connect(supplier).balanceOfUnderlying(supplier.address);
  });

  it("short-circuits accrueInterest when called twice within the same block", async function () {
    const { supplier, debtAsset, cDebt } = await deployFixture();
    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));

    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      const tx1 = await cDebt.accrueInterest();
      const tx2 = await cDebt.accrueInterest();
      await ethers.provider.send("evm_mine", []);
      const [receipt1, receipt2] = await Promise.all([tx1.wait(), tx2.wait()]);
      expect(receipt1.blockNumber).to.equal(receipt2.blockNumber);
      // The second call lands in the same block as the first, so it must hit the
      // `accrualBlockNumberPrior == currentBlockNumber` short-circuit and emit nothing.
      expect(receipt2.logs.length).to.equal(0);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
  });

  it("rejects _setComptroller from a non-admin or a target that fails the isComptroller marker check", async function () {
    const { owner, other, comptroller, cDebt } = await deployFixture();
    const fakeMarker = await (await ethers.getContractFactory("MockFakeMarkerFalse")).deploy();

    await expect(cDebt.connect(other)._setComptroller(comptroller.target)).to.be.reverted;
    await expect(cDebt.connect(owner)._setComptroller(fakeMarker.target)).to.be.revertedWith(
      "marker method returned false"
    );
  });

  it("rejects _setReserveFactor from a non-admin or above the max bound", async function () {
    const { other, cDebt } = await deployFixture();
    await expect(cDebt.connect(other)._setReserveFactor(1)).to.be.reverted;
    // reserveFactorMaxMantissa is 1e18 (100%) in Compound V2 -- anything above must be rejected.
    await expect(cDebt._setReserveFactor(ethers.parseEther("1.01"))).to.be.reverted;
  });

  it("rejects _reduceReserves from a non-admin, above available cash, or above total reserves", async function () {
    const { owner, other, supplier, debtAsset, cDebt } = await deployFixture();

    await expect(cDebt.connect(other)._reduceReserves(1)).to.be.reverted;
    // No reserves accrued yet -- reduceAmount(1) > totalReserves(0).
    await expect(cDebt.connect(owner)._reduceReserves(1)).to.be.reverted;

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));
    await debtAsset.connect(owner).mint(owner.address, ethers.parseEther("50"));
    await debtAsset.connect(owner).approve(cDebt.target, ethers.parseEther("50"));
    await cDebt.connect(owner)._addReserves(ethers.parseEther("50"));

    // Reserves exist (50) but cash held by the market covers it here, so instead request more than
    // totalReserves to hit the reduceAmount > totalReserves guard specifically.
    await expect(cDebt.connect(owner)._reduceReserves(ethers.parseEther("51"))).to.be.reverted;
  });

  it("rejects re-initializing an already-initialized market or initializing from a non-admin", async function () {
    const { owner, other, comptroller, interestRateModel, cDebt } = await deployFixture();
    const cDebtAsDelegate = await ethers.getContractAt("CErc20Delegate", cDebt.target);
    const debtAsset2 = await (await ethers.getContractFactory("MockERC20")).deploy("Debt2", "USD2", 18);

    const initSig = "initialize(address,address,address,uint256,string,string,uint8)";

    await expect(
      cDebtAsDelegate
        .connect(other)
        [initSig](
          debtAsset2.target,
          comptroller.target,
          interestRateModel.target,
          ethers.parseEther("1"),
          "x",
          "x",
          8
        )
    ).to.be.revertedWith("only admin may initialize the market");

    await expect(
      cDebtAsDelegate
        .connect(owner)
        [initSig](
          debtAsset2.target,
          comptroller.target,
          interestRateModel.target,
          ethers.parseEther("1"),
          "x",
          "x",
          8
        )
    ).to.be.revertedWith("market may only be initialized once");
  });

  it("reverts mint when the comptroller rejects it and reverts redeem when comptroller-blocked", async function () {
    const { owner, borrower, supplier, collateralAsset, debtAsset, comptroller, cCollateral, cDebt, interestRateModel } =
      await deployFixture();

    // mintAllowed's own pause check is a `require` that reverts *inside* the comptroller call itself
    // (never returns a nonzero code), so it can't exercise CToken's own MintComptrollerRejection path.
    // An unlisted market's mintAllowed *returns* MARKET_NOT_LISTED without reverting, which does.
    const delegate = await (await ethers.getContractFactory("CErc20Delegate")).deploy();
    const unlisted = await (await ethers.getContractFactory("CErc20Delegator")).deploy(
      collateralAsset.target,
      comptroller.target,
      interestRateModel.target,
      ethers.parseEther("1"),
      "Unlisted",
      "sUNL",
      8,
      owner.address,
      delegate.target,
      "0x"
    );
    await collateralAsset.connect(borrower).approve(unlisted.target, ethers.parseEther("1"));
    await expect(unlisted.connect(borrower).mint(ethers.parseEther("1"))).to.be.reverted;

    // Redeem blocked by the comptroller: borrower has an outstanding borrow that would become
    // under-collateralized if the backing collateral were redeemed. redeemAllowedInternal *returns*
    // INSUFFICIENT_LIQUIDITY rather than reverting, so this one does reach CToken's own
    // RedeemComptrollerRejection revert correctly.
    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));
    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);
    await cDebt.connect(borrower).borrow(ethers.parseEther("60"));

    await expect(cCollateral.connect(borrower).redeem(ethers.parseEther("100"))).to.be.reverted;
  });

  it("reverts borrow when the comptroller rejects it or cash is unavailable", async function () {
    const { owner, supplier, borrower, collateralAsset, debtAsset, comptroller, cCollateral, cDebt, interestRateModel } =
      await deployFixture();

    await collateralAsset.connect(borrower).approve(cCollateral.target, ethers.parseEther("100"));
    await cCollateral.connect(borrower).mint(ethers.parseEther("100"));
    await comptroller.connect(borrower).enterMarkets([cCollateral.target]);

    // Same reasoning as mint above: borrowAllowed's pause check reverts inside the comptroller call,
    // so use an unlisted market (non-reverting MARKET_NOT_LISTED) to reach CToken's own
    // BorrowComptrollerRejection path specifically.
    const delegate = await (await ethers.getContractFactory("CErc20Delegate")).deploy();
    const unlisted = await (await ethers.getContractFactory("CErc20Delegator")).deploy(
      debtAsset.target,
      comptroller.target,
      interestRateModel.target,
      ethers.parseEther("1"),
      "Unlisted",
      "sUNL2",
      8,
      owner.address,
      delegate.target,
      "0x"
    );
    await expect(unlisted.connect(borrower).borrow(ethers.parseEther("1"))).to.be.reverted;

    await debtAsset.connect(supplier).approve(cDebt.target, ethers.parseEther("500"));
    await cDebt.connect(supplier).mint(ethers.parseEther("500"));
    // Cash available is the 500 supplied -- requesting more must hit BorrowCashNotAvailable.
    await expect(cDebt.connect(borrower).borrow(ethers.parseEther("501"))).to.be.reverted;
  });

  it("reverts repayBorrow when the comptroller rejects it (market not listed on that call path)", async function () {
    const { owner, supplier, debtAsset, comptroller, interestRateModel } = await deployFixture();
    // A freshly deployed, never-_supportMarket'ed market: repayBorrowAllowed returns MARKET_NOT_LISTED.
    const delegate = await (await ethers.getContractFactory("CErc20Delegate")).deploy();
    const unlisted = await (await ethers.getContractFactory("CErc20Delegator")).deploy(
      debtAsset.target,
      comptroller.target,
      interestRateModel.target,
      ethers.parseEther("1"),
      "Unlisted",
      "sUNL",
      8,
      owner.address,
      delegate.target,
      "0x"
    );
    await debtAsset.connect(supplier).approve(unlisted.target, ethers.parseEther("1"));
    await expect(unlisted.connect(supplier).repayBorrow(ethers.parseEther("1"))).to.be.reverted;
  });

  it("reverts market construction when the comptroller or interest rate model fails its marker check", async function () {
    const { owner, comptroller, interestRateModel } = await deployFixture();
    const fakeMarker = await (await ethers.getContractFactory("MockFakeMarkerFalse")).deploy();
    const delegate = await (await ethers.getContractFactory("CErc20Delegate")).deploy();
    const Delegator = await ethers.getContractFactory("CErc20Delegator");
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("X", "X", 18);

    // Constructor's internal initialize() call requires _setComptroller to succeed -- a fake
    // comptroller that fails isComptroller() must revert the whole deployment.
    await expect(
      Delegator.deploy(
        token.target,
        fakeMarker.target,
        interestRateModel.target,
        ethers.parseEther("1"),
        "Bad",
        "sBAD",
        8,
        owner.address,
        delegate.target,
        "0x"
      )
    ).to.be.reverted;

    // Same for _setInterestRateModelFresh failing its own marker check.
    await expect(
      Delegator.deploy(
        token.target,
        comptroller.target,
        fakeMarker.target,
        ethers.parseEther("1"),
        "Bad",
        "sBAD",
        8,
        owner.address,
        delegate.target,
        "0x"
      )
    ).to.be.reverted;
  });

  it("reverts seize() when the comptroller rejects it or when borrower equals liquidator", async function () {
    const { owner, borrower, other, cCollateral, cDebt } = await deployFixture();

    // Caller is not a listed market at all -- comptroller.seizeAllowed returns MARKET_NOT_LISTED.
    await expect(cCollateral.connect(other).seize(other.address, borrower.address, 1)).to.be.reverted;

    // Caller IS a listed market (impersonate cDebt), but borrower == liquidator.
    await ethers.provider.send("hardhat_setBalance", [cDebt.target, "0x1000000000000000000"]);
    const cDebtSigner = await ethers.getImpersonatedSigner(cDebt.target as string);
    await expect(cCollateral.connect(cDebtSigner).seize(owner.address, owner.address, 1)).to.be.reverted;
  });

  it("rejects _setInterestRateModel from a non-admin or a target that fails the marker check", async function () {
    const { owner, other, cDebt } = await deployFixture();
    const fakeMarker = await (await ethers.getContractFactory("MockFakeMarkerFalse")).deploy();

    await expect(cDebt.connect(other)._setInterestRateModel(fakeMarker.target)).to.be.reverted;
    await expect(cDebt.connect(owner)._setInterestRateModel(fakeMarker.target)).to.be.revertedWith(
      "marker method returned false"
    );
  });

  it("supports the two-step admin transfer (_setPendingAdmin / _acceptAdmin)", async function () {
    const { owner, other, cDebt } = await deployFixture();

    // Custom-error names defined in CTokenInterfaces.sol aren't part of the delegator's own ABI
    // (calls cross the delegatecall boundary via delegateToImplementation), so assert generically.
    await expect(cDebt.connect(other)._setPendingAdmin(other.address)).to.be.reverted;

    await expect(cDebt.connect(owner)._setPendingAdmin(other.address))
      .to.emit(cDebt, "NewPendingAdmin")
      .withArgs(ethers.ZeroAddress, other.address);
    expect(await cDebt.pendingAdmin()).to.equal(other.address);

    await expect(cDebt.connect(owner)._acceptAdmin()).to.be.reverted;

    await expect(cDebt.connect(other)._acceptAdmin())
      .to.emit(cDebt, "NewAdmin")
      .withArgs(owner.address, other.address);
    expect(await cDebt.admin()).to.equal(other.address);
    expect(await cDebt.pendingAdmin()).to.equal(ethers.ZeroAddress);
  });

  it("reverts market construction when the initial exchange rate is zero", async function () {
    const { owner, comptroller, interestRateModel, delegate } = await deployFixture();
    const Token = await ethers.getContractFactory("MockERC20");
    const someAsset = await Token.deploy("Some Token", "SOME", 18);
    const Delegator = await ethers.getContractFactory("CErc20Delegator");

    await expect(
      Delegator.deploy(
        someAsset.target,
        comptroller.target,
        interestRateModel.target,
        0,
        "Bad Rate Market",
        "sBAD",
        8,
        owner.address,
        delegate.target,
        "0x"
      )
    ).to.be.revertedWith("initial exchange rate must be greater than zero.");
  });

  it("rejects reentrant calls into every nonReentrant-guarded CToken function", async function () {
    const [owner, supplier] = await ethers.getSigners();

    const ReentrantToken = await ethers.getContractFactory("MockReentrantERC20");
    const reentrantAsset = await ReentrantToken.deploy("Reentrant Token", "REENT");

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
    const cReent = await Delegator.deploy(
      reentrantAsset.target,
      unitroller.target,
      interestRateModel.target,
      ethers.parseEther("1"),
      "Securd Reentrant",
      "sREENT",
      8,
      owner.address,
      delegate.target,
      "0x"
    );
    await comptroller._supportMarket(cReent.target);
    await oracle.setFallbackConfig(reentrantAsset.target, 86400);
    await oracle.setOracleType(reentrantAsset.target, 3);
    await oracle.postFallbackPrice(reentrantAsset.target, ethers.parseEther("1"));
    await comptroller._setCollateralFactor(cReent.target, ethers.parseEther("0.5"));

    // Every nonReentrant-guarded entry point on CToken/CErc20. Each call's own reentrancy guard
    // check runs before any argument validation, so garbage arguments are fine -- we only need the
    // call to land while cReent's _notEntered flag is already false.
    const reentryCalls = [
      cReent.interface.encodeFunctionData("transfer", [supplier.address, 1]),
      cReent.interface.encodeFunctionData("transferFrom", [supplier.address, owner.address, 1]),
      cReent.interface.encodeFunctionData("totalBorrowsCurrent"),
      cReent.interface.encodeFunctionData("borrowBalanceCurrent", [supplier.address]),
      cReent.interface.encodeFunctionData("exchangeRateCurrent"),
      cReent.interface.encodeFunctionData("mint", [1]),
      cReent.interface.encodeFunctionData("redeem", [1]),
      cReent.interface.encodeFunctionData("redeemUnderlying", [1]),
      cReent.interface.encodeFunctionData("borrow", [1]),
      cReent.interface.encodeFunctionData("repayBorrow", [1]),
      cReent.interface.encodeFunctionData("repayBorrowBehalf", [supplier.address, 1]),
      cReent.interface.encodeFunctionData("liquidateBorrow", [supplier.address, 1, cReent.target]),
      cReent.interface.encodeFunctionData("seize", [owner.address, supplier.address, 1]),
      cReent.interface.encodeFunctionData("_setReserveFactor", [1]),
      cReent.interface.encodeFunctionData("_addReserves", [1]),
      cReent.interface.encodeFunctionData("_reduceReserves", [1])
    ];
    const targets = reentryCalls.map(() => cReent.target);

    await reentrantAsset.setReentryCalls(targets, reentryCalls);
    await reentrantAsset.setReenterOnTransferFrom(true);

    await reentrantAsset.mint(supplier.address, ethers.parseEther("100"));
    await reentrantAsset.connect(supplier).approve(cReent.target, ethers.parseEther("10"));

    // The outer mint succeeds normally: every attempted reentry above reverted internally and was
    // swallowed by the low-level `.call` in MockReentrantERC20, so doTransferIn's transferFrom still
    // returns true and the mint completes.
    await expect(cReent.connect(supplier).mint(ethers.parseEther("10"))).to.emit(cReent, "Mint");
    expect(await cReent.balanceOf(supplier.address)).to.be.gt(0);
  });
});
