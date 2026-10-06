// @ts-nocheck
import { expect } from "chai";
import { ethers, network } from "hardhat";

describe("SecurdCollateralFactorTimelockV2", function () {
  const DAY = 86400;
  const HOUR = 3600;

  async function deployFixture() {
    const [owner, attacker, cToken] = await ethers.getSigners();
    const timelock = await (await ethers.getContractFactory("SecurdCollateralFactorTimelockV2")).deploy(owner.address);
    const target = await (await ethers.getContractFactory("MockTimelockTargetV2")).deploy();
    return { owner, attacker, cToken, timelock, target };
  }

  async function queueAndGetId(timelock, target, data, delay) {
    const tx = await timelock.queue(target.target, 0, data, delay);
    const receipt = await tx.wait();
    const ev = receipt.logs.find((l) => l.fragment?.name === "ActionQueued");
    return ev.args.actionId;
  }

  async function advanceTo(ts) {
    await network.provider.send("evm_setNextBlockTimestamp", [ts]);
    await network.provider.send("evm_mine", []);
  }

  describe("bool-returning pause functions (the original bug)", function () {
    it("executes _setMintPaused(true) — returns true, a successful pause", async function () {
      const { timelock, target, cToken } = await deployFixture();
      const data = target.interface.encodeFunctionData("_setMintPaused", [cToken.address, true]);
      const id = await queueAndGetId(timelock, target, data, 0);
      await expect(timelock.execute(id)).to.emit(timelock, "ActionExecuted");
      expect(await target.mintPaused()).to.equal(true);
    });

    it("executes _setMintPaused(false) — returns false, which is a valid unpause, not a failure", async function () {
      const { timelock, target, cToken } = await deployFixture();
      const pause = target.interface.encodeFunctionData("_setMintPaused", [cToken.address, true]);
      await timelock.execute(await queueAndGetId(timelock, target, pause, 0));
      const unpause = target.interface.encodeFunctionData("_setMintPaused", [cToken.address, false]);
      await expect(timelock.execute(await queueAndGetId(timelock, target, unpause, 0))).to.emit(
        timelock,
        "ActionExecuted"
      );
      expect(await target.mintPaused()).to.equal(false);
    });

    it("rejects a bool-selector return of 2 (not a canonical bool)", async function () {
      const { timelock, target } = await deployFixture();
      await target.setTransferRet(2);
      const data = target.interface.encodeFunctionData("_setTransferPaused", [true]);
      const id = await queueAndGetId(timelock, target, data, 0);
      await expect(timelock.execute(id)).to.be.revertedWithCustomError(timelock, "InvalidBoolReturn");
    });

    it("accepts a bool-selector return of 1 and 0", async function () {
      const { timelock, target } = await deployFixture();
      const data = target.interface.encodeFunctionData("_setTransferPaused", [true]);
      await target.setTransferRet(1);
      await expect(timelock.execute(await queueAndGetId(timelock, target, data, 0))).to.emit(timelock, "ActionExecuted");
      await target.setTransferRet(0);
      await expect(timelock.execute(await queueAndGetId(timelock, target, data, 0))).to.emit(timelock, "ActionExecuted");
    });
  });

  describe("uint256-returning Compound admin functions (unchanged behavior)", function () {
    it("reverts when a uint error code is non-zero", async function () {
      const { timelock, target, cToken } = await deployFixture();
      await target.setCfErr(9);
      const data = target.interface.encodeFunctionData("_setCollateralFactor", [cToken.address, ethers.parseEther("0.35")]);
      const id = await queueAndGetId(timelock, target, data, 48 * HOUR);
      await advanceTo((await ethers.provider.getBlock("latest")).timestamp + 48 * HOUR + 1);
      await expect(timelock.execute(id)).to.be.revertedWithCustomError(timelock, "ExecutionFailed");
    });

    it("executes a collateral-factor change when the error code is zero, after the 48-hour minimum", async function () {
      const { timelock, target, cToken } = await deployFixture();
      await target.setCfErr(0);
      const data = target.interface.encodeFunctionData("_setCollateralFactor", [cToken.address, ethers.parseEther("0.35")]);
      const id = await queueAndGetId(timelock, target, data, 48 * HOUR);
      await advanceTo((await ethers.provider.getBlock("latest")).timestamp + 48 * HOUR + 1);
      await expect(timelock.execute(id)).to.emit(timelock, "ActionExecuted");
    });
  });

  describe("collateral-factor delay rules (production minimum kept)", function () {
    it("rejects a collateral-factor change queued with less than 48 hours", async function () {
      const { timelock, target, cToken } = await deployFixture();
      const data = target.interface.encodeFunctionData("_setCollateralFactor", [cToken.address, ethers.parseEther("0.35")]);
      await expect(timelock.queue(target.target, 0, data, 10 * 60)).to.be.revertedWithCustomError(timelock, "DelayTooShort");
      await expect(timelock.queue(target.target, 0, data, 48 * HOUR - 1)).to.be.revertedWithCustomError(timelock, "DelayTooShort");
    });

    it("allows exactly 48 hours for a collateral-factor change", async function () {
      const { timelock, target, cToken } = await deployFixture();
      const data = target.interface.encodeFunctionData("_setCollateralFactor", [cToken.address, ethers.parseEther("0.35")]);
      await expect(timelock.queue(target.target, 0, data, 48 * HOUR)).to.emit(timelock, "ActionQueued");
    });

    it("rejects execution before the eta", async function () {
      const { timelock, target, cToken } = await deployFixture();
      const data = target.interface.encodeFunctionData("_setCollateralFactor", [cToken.address, ethers.parseEther("0.35")]);
      const id = await queueAndGetId(timelock, target, data, 48 * HOUR);
      await expect(timelock.execute(id)).to.be.revertedWithCustomError(timelock, "ActionNotReady");
    });

    it("rejects execution after the 7-day grace period", async function () {
      const { timelock, target, cToken } = await deployFixture();
      const data = target.interface.encodeFunctionData("_setCollateralFactor", [cToken.address, ethers.parseEther("0.35")]);
      const id = await queueAndGetId(timelock, target, data, 48 * HOUR);
      const eta = (await ethers.provider.getBlock("latest")).timestamp + 48 * HOUR;
      await advanceTo(eta + 7 * DAY + 10);
      await expect(timelock.execute(id)).to.be.revertedWithCustomError(timelock, "ActionExpired");
    });

    it("rejects a delay above the 30-day maximum", async function () {
      const { timelock, target } = await deployFixture();
      await expect(timelock.queue(target.target, 0, "0x", 31 * DAY)).to.be.revertedWithCustomError(timelock, "DelayTooLong");
    });
  });

  describe("access control and queue hygiene", function () {
    it("only the owner can queue, execute, cancel", async function () {
      const { timelock, target, attacker } = await deployFixture();
      await expect(timelock.connect(attacker).queue(target.target, 0, "0x", 0)).to.be.revertedWith("Ownable: caller is not the owner");
      await expect(timelock.connect(attacker).execute(ethers.ZeroHash)).to.be.revertedWith("Ownable: caller is not the owner");
      await expect(timelock.connect(attacker).cancel(ethers.ZeroHash)).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("cancel removes a queued action so it can no longer execute", async function () {
      const { timelock, target, cToken } = await deployFixture();
      const data = target.interface.encodeFunctionData("_setMintPaused", [cToken.address, true]);
      const id = await queueAndGetId(timelock, target, data, 0);
      await timelock.cancel(id);
      await expect(timelock.execute(id)).to.be.revertedWithCustomError(timelock, "ActionNotQueued");
    });

    it("rejects queuing the zero target", async function () {
      const { timelock } = await deployFixture();
      await expect(timelock.queue(ethers.ZeroAddress, 0, "0x", 0)).to.be.revertedWithCustomError(timelock, "InvalidTarget");
    });

    it("queuing the same action later yields a distinct action id (eta is part of the id)", async function () {
      const { timelock, target, cToken } = await deployFixture();
      const data = target.interface.encodeFunctionData("_setMintPaused", [cToken.address, true]);
      const first = await queueAndGetId(timelock, target, data, 0);
      await network.provider.send("evm_mine", []);
      const second = await queueAndGetId(timelock, target, data, 0);
      expect(second).to.not.equal(first);
    });
  });
});
