// @ts-nocheck
import { expect } from "chai";
import { ethers } from "hardhat";

const MIN_DELAY = 48 * 3600; // 48 hours in seconds
const GRACE_PERIOD = 7 * 24 * 3600; // 7 days
const SET_CF_SELECTOR = "0xe4028eee"; // _setCollateralFactor(address,uint256)

function encodeSetCollateralFactor(cToken: string, factor: bigint): string {
  return ethers.concat([
    SET_CF_SELECTOR,
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [cToken, factor])
  ]);
}

describe("SecurdCollateralFactorTimelock", function () {
  async function deployFixture() {
    const [owner, other] = await ethers.getSigners();
    const timelock = await (await ethers.getContractFactory("SecurdCollateralFactorTimelock")).deploy(owner.address);
    const mock = await (await ethers.getContractFactory("MockComptrollerAdmin")).deploy();
    return { owner, other, timelock, mock };
  }

  it("accepts Unitroller admin via acceptUnitrollerAdmin", async function () {
    const { owner, timelock, mock } = await deployFixture();

    // Current mock admin (owner) sets timelock as pending admin
    await mock._setPendingAdmin(await timelock.getAddress());
    expect(await mock.pendingAdmin()).to.equal(await timelock.getAddress());

    // Timelock accepts
    await timelock.acceptUnitrollerAdmin(await mock.getAddress());
    expect(await mock.admin()).to.equal(await timelock.getAddress());
  });

  it("rejects acceptUnitrollerAdmin from non-owner", async function () {
    const { other, timelock, mock } = await deployFixture();
    await mock._setPendingAdmin(await timelock.getAddress());
    await expect(timelock.connect(other).acceptUnitrollerAdmin(await mock.getAddress())).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
  });

  it("requires MIN_DELAY for collateral factor changes", async function () {
    const { timelock, mock } = await deployFixture();
    const cToken = ethers.Wallet.createRandom().address;
    const data = encodeSetCollateralFactor(cToken, ethers.parseEther("0.75"));

    // Delay below minimum is rejected
    await expect(
      timelock.queue(await mock.getAddress(), 0, data, MIN_DELAY - 1)
    ).to.be.revertedWithCustomError(timelock, "DelayTooShort");

    // Exactly minimum is accepted
    await expect(
      timelock.queue(await mock.getAddress(), 0, data, MIN_DELAY)
    ).to.emit(timelock, "ActionQueued");
  });

  it("allows non-collateral-factor calls with zero delay", async function () {
    const { timelock, mock } = await deployFixture();
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [0]); // arbitrary non-CF call

    const tx = await timelock.queue(await mock.getAddress(), 0, data, 0);
    const receipt = await tx.wait();
    const event = receipt.logs.find((l: any) => l.fragment?.name === "ActionQueued");
    expect(event).to.not.be.undefined;
  });

  it("executes a collateral factor change after MIN_DELAY", async function () {
    const { timelock, mock } = await deployFixture();
    await mock._setPendingAdmin(await timelock.getAddress());
    await timelock.acceptUnitrollerAdmin(await mock.getAddress());

    const cToken = ethers.Wallet.createRandom().address;
    const newFactor = ethers.parseEther("0.7");
    const data = encodeSetCollateralFactor(cToken, newFactor);

    const tx = await timelock.queue(await mock.getAddress(), 0, data, MIN_DELAY);
    const receipt = await tx.wait();
    const event = receipt.logs.find((l: any) => l.fragment?.name === "ActionQueued");
    const actionId = event.args.actionId;

    // Not yet executable
    await expect(timelock.execute(actionId)).to.be.revertedWithCustomError(timelock, "ActionNotReady");

    // Advance time past the delay
    await ethers.provider.send("evm_increaseTime", [MIN_DELAY]);
    await ethers.provider.send("evm_mine", []);

    await expect(timelock.execute(actionId)).to.emit(timelock, "ActionExecuted");

    expect(await mock.lastCollateralFactorCToken()).to.equal(cToken);
    expect(await mock.lastCollateralFactorMantissa()).to.equal(newFactor);
  });

  it("prevents execution after the grace period expires", async function () {
    const { timelock, mock } = await deployFixture();
    const cToken = ethers.Wallet.createRandom().address;
    const data = encodeSetCollateralFactor(cToken, ethers.parseEther("0.7"));

    const tx = await timelock.queue(await mock.getAddress(), 0, data, MIN_DELAY);
    const receipt = await tx.wait();
    const actionId = receipt.logs.find((l: any) => l.fragment?.name === "ActionQueued").args.actionId;

    // Advance past delay + grace period
    await ethers.provider.send("evm_increaseTime", [MIN_DELAY + GRACE_PERIOD + 1]);
    await ethers.provider.send("evm_mine", []);

    await expect(timelock.execute(actionId)).to.be.revertedWithCustomError(timelock, "ActionExpired");
  });

  it("cancels a queued action before execution", async function () {
    const { timelock, mock } = await deployFixture();
    const cToken = ethers.Wallet.createRandom().address;
    const data = encodeSetCollateralFactor(cToken, ethers.parseEther("0.7"));

    const tx = await timelock.queue(await mock.getAddress(), 0, data, MIN_DELAY);
    const actionId = (await tx.wait()).logs.find((l: any) => l.fragment?.name === "ActionQueued").args.actionId;

    await expect(timelock.cancel(actionId)).to.emit(timelock, "ActionCancelled");

    // After cancellation, action no longer exists
    await ethers.provider.send("evm_increaseTime", [MIN_DELAY]);
    await ethers.provider.send("evm_mine", []);
    await expect(timelock.execute(actionId)).to.be.revertedWithCustomError(timelock, "ActionNotQueued");
  });

  it("stores queued action state and rejects the same actionId after re-queuing", async function () {
    const { timelock, mock } = await deployFixture();
    const cToken = ethers.Wallet.createRandom().address;
    const data = encodeSetCollateralFactor(cToken, ethers.parseEther("0.7"));

    // Queue once — action must be stored
    const tx = await timelock.queue(await mock.getAddress(), 0, data, MIN_DELAY);
    const receipt = await tx.wait();
    const event = receipt.logs.find((l: any) => l.fragment?.name === "ActionQueued");
    const actionId = event.args.actionId;

    const stored = await timelock.queuedActions(actionId);
    expect(stored.exists).to.be.true;
    expect(stored.target).to.equal(await mock.getAddress());

    // Cancel and re-queue — since the timestamp is now different, a new actionId is produced
    await timelock.cancel(actionId);
    const tx2 = await timelock.queue(await mock.getAddress(), 0, data, MIN_DELAY);
    const receipt2 = await tx2.wait();
    const actionId2 = receipt2.logs.find((l: any) => l.fragment?.name === "ActionQueued").args.actionId;

    // New actionId because a new block has a different timestamp → different eta
    expect(actionId2).to.not.equal(actionId);
    // First action no longer exists; second does
    expect((await timelock.queuedActions(actionId)).exists).to.be.false;
    expect((await timelock.queuedActions(actionId2)).exists).to.be.true;
  });

  it("rejects delay above MAX_DELAY", async function () {
    const { timelock, mock } = await deployFixture();
    const MAX_DELAY = 30 * 24 * 3600;
    const data = encodeSetCollateralFactor(ethers.Wallet.createRandom().address, ethers.parseEther("0.7"));

    await expect(
      timelock.queue(await mock.getAddress(), 0, data, MAX_DELAY + 1)
    ).to.be.revertedWithCustomError(timelock, "DelayTooLong");
  });

  it("only owner can queue, execute, and cancel", async function () {
    const { other, timelock, mock } = await deployFixture();
    const data = encodeSetCollateralFactor(ethers.Wallet.createRandom().address, ethers.parseEther("0.7"));

    await expect(
      timelock.connect(other).queue(await mock.getAddress(), 0, data, MIN_DELAY)
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(timelock.connect(other).execute(ethers.ZeroHash)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );

    await expect(timelock.connect(other).cancel(ethers.ZeroHash)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
  });

  it("transfers ownership when the initial owner differs from the deployer", async function () {
    const [deployer, owner] = await ethers.getSigners();
    const timelock = await (await ethers.getContractFactory("SecurdCollateralFactorTimelock"))
      .connect(deployer)
      .deploy(owner.address);
    expect(await timelock.owner()).to.equal(owner.address);
  });

  it("rejects a zero owner at construction", async function () {
    const Timelock = await ethers.getContractFactory("SecurdCollateralFactorTimelock");
    await expect(Timelock.deploy(ethers.ZeroAddress)).to.be.revertedWith("owner=0");
  });

  it("rejects acceptUnitrollerAdmin with the zero address", async function () {
    const { timelock } = await deployFixture();
    await expect(timelock.acceptUnitrollerAdmin(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      timelock,
      "InvalidTarget"
    );
  });

  it("reverts acceptUnitrollerAdmin when the underlying _acceptAdmin call fails", async function () {
    const { timelock, mock } = await deployFixture();
    await mock._setPendingAdmin(await timelock.getAddress());
    await mock.setNextErrorCode(7);

    await expect(timelock.acceptUnitrollerAdmin(await mock.getAddress())).to.be.revertedWith(
      "acceptAdmin failed"
    );
  });

  it("rejects queue with the zero target", async function () {
    const { timelock } = await deployFixture();
    await expect(timelock.queue(ethers.ZeroAddress, 0, "0x", 0)).to.be.revertedWithCustomError(
      timelock,
      "InvalidTarget"
    );
  });

  it("rejects queuing the exact same action twice in the same block", async function () {
    const { timelock, mock } = await deployFixture();
    const data = encodeSetCollateralFactor(ethers.Wallet.createRandom().address, ethers.parseEther("0.7"));

    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      await timelock.queue(await mock.getAddress(), 0, data, MIN_DELAY);
      await timelock.queue(await mock.getAddress(), 0, data, MIN_DELAY);
      await ethers.provider.send("evm_mine", []);

      const block = await ethers.provider.getBlock("latest");
      // Both queue calls landed in this same block, so block.timestamp (and therefore eta and
      // actionId) is identical for both -- the second must revert with ActionAlreadyQueued.
      expect(block.transactions.length).to.equal(2);
      const receipts = await Promise.all(block.transactions.map((h: string) => ethers.provider.getTransactionReceipt(h)));
      expect(receipts[0].status).to.equal(1);
      expect(receipts[1].status).to.equal(0);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
  });

  it("reverts execute when the target call itself fails", async function () {
    const { timelock, mock } = await deployFixture();
    // Unrecognized selector on a mock with no fallback -- the low-level call itself fails.
    const badData = "0xdeadbeef";

    const tx = await timelock.queue(await mock.getAddress(), 0, badData, 0);
    const actionId = (await tx.wait()).logs.find((l: any) => l.fragment?.name === "ActionQueued").args.actionId;

    await expect(timelock.execute(actionId)).to.be.revertedWithCustomError(timelock, "ExecutionFailed");
  });

  it("reverts execute when the target returns a non-zero Compound-style error code", async function () {
    const { timelock, mock } = await deployFixture();
    await mock.setNextErrorCode(3);
    const data = encodeSetCollateralFactor(ethers.Wallet.createRandom().address, ethers.parseEther("0.7"));

    const tx = await timelock.queue(await mock.getAddress(), 0, data, MIN_DELAY);
    const actionId = (await tx.wait()).logs.find((l: any) => l.fragment?.name === "ActionQueued").args.actionId;

    await ethers.provider.send("evm_increaseTime", [MIN_DELAY]);
    await ethers.provider.send("evm_mine", []);

    await expect(timelock.execute(actionId)).to.be.revertedWithCustomError(timelock, "ExecutionFailed");
  });

  it("executes successfully against a target that returns no data", async function () {
    const { timelock } = await deployFixture();
    // A call to an address with no contract code succeeds with empty (non-32-byte) return data,
    // exercising the ret.length != 32 branch distinctly from the Compound-error-code branch.
    const eoaTarget = ethers.Wallet.createRandom().address;

    const tx = await timelock.queue(eoaTarget, 0, "0x", 0);
    const actionId = (await tx.wait()).logs.find((l: any) => l.fragment?.name === "ActionQueued").args.actionId;

    await expect(timelock.execute(actionId)).to.emit(timelock, "ActionExecuted");
  });

  it("rejects cancel for an action that was never queued", async function () {
    const { timelock } = await deployFixture();
    await expect(timelock.cancel(ethers.ZeroHash)).to.be.revertedWithCustomError(timelock, "ActionNotQueued");
  });
});
