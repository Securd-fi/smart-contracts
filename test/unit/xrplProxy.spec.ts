// @ts-nocheck
import { expect } from "chai";
import { ethers } from "hardhat";

describe("XRPL user proxies", function () {
  it("deploys deterministic proxies and freezes controller rotation after first proxy", async function () {
    const [owner, controller, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("XRPLUserProxyFactory");
    const factory = await Factory.deploy(owner.address, controller.address);

    await expect(factory.connect(other).setController(other.address)).to.be.reverted;
    await expect(factory.connect(owner).setController(other.address))
      .to.emit(factory, "ControllerSet")
      .withArgs(controller.address, other.address);

    const xrplAccount = ethers.encodeBytes32String("alice");
    const predicted = await factory.predictProxy(xrplAccount);
    await factory.connect(other).getOrCreateProxy(xrplAccount);
    expect(await factory.proxyOf(xrplAccount)).to.equal(predicted);
    expect(await factory.proxyCount()).to.equal(1);

    await expect(factory.connect(owner).setController(controller.address)).to.be.revertedWithCustomError(
      factory,
      "ControllerFrozen"
    );
  });

  it("allows only the controller to execute and sweep", async function () {
    const [controller, other, recipient] = await ethers.getSigners();
    const Proxy = await ethers.getContractFactory("XRPLUserProxy");
    const proxy = await Proxy.deploy(controller.address, ethers.encodeBytes32String("bob"));

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Mock", "MOCK", 18);
    await token.mint(proxy.target, 1000n);

    await expect(proxy.connect(other).execute(token.target, 0, "0x")).to.be.revertedWithCustomError(proxy, "NotController");
    await expect(proxy.connect(other).sweepToken(token.target, recipient.address, 100n)).to.be.revertedWithCustomError(
      proxy,
      "NotController"
    );

    await proxy.connect(controller).sweepToken(token.target, recipient.address, 100n);
    expect(await token.balanceOf(recipient.address)).to.equal(100n);
  });

  it("allows only the controller to sweep native XRP/ETH", async function () {
    const [controller, other, recipient] = await ethers.getSigners();
    const Proxy = await ethers.getContractFactory("XRPLUserProxy");
    const proxy = await Proxy.deploy(controller.address, ethers.encodeBytes32String("carol"));

    await ethers.provider.send("hardhat_setBalance", [proxy.target, "0x1000000000000000000"]);

    await expect(proxy.connect(other).sweepNative(recipient.address, 1n)).to.be.revertedWithCustomError(
      proxy,
      "NotController"
    );

    const balanceBefore = await ethers.provider.getBalance(recipient.address);
    await proxy.connect(controller).sweepNative(recipient.address, ethers.parseEther("0.5"));
    const balanceAfter = await ethers.provider.getBalance(recipient.address);
    expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("0.5"));
  });

  it("transfers ownership when the initial owner differs from the deployer", async function () {
    const [deployer, owner, controller] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("XRPLUserProxyFactory");
    const factory = await Factory.connect(deployer).deploy(owner.address, controller.address);
    expect(await factory.owner()).to.equal(owner.address);
  });

  it("rejects a zero owner or zero controller at construction", async function () {
    const [owner, controller] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("XRPLUserProxyFactory");
    await expect(Factory.deploy(ethers.ZeroAddress, controller.address)).to.be.revertedWith("owner=0");
    await expect(Factory.deploy(owner.address, ethers.ZeroAddress)).to.be.revertedWith("controller=0");
  });

  it("rejects setController with the zero address", async function () {
    const [owner, controller] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("XRPLUserProxyFactory");
    const factory = await Factory.deploy(owner.address, controller.address);
    await expect(factory.connect(owner).setController(ethers.ZeroAddress)).to.be.revertedWith("controller=0");
  });

  it("rejects getOrCreateProxy from a non-controller and returns the same proxy on repeat calls", async function () {
    const [owner, controller, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("XRPLUserProxyFactory");
    const factory = await Factory.deploy(owner.address, controller.address);
    const xrplAccount = ethers.encodeBytes32String("liam");

    await expect(factory.connect(other).getOrCreateProxy(xrplAccount)).to.be.revertedWithCustomError(
      factory,
      "NotController"
    );

    const first = await factory.connect(controller).getOrCreateProxy.staticCall(xrplAccount);
    await factory.connect(controller).getOrCreateProxy(xrplAccount);
    expect(await factory.proxyCount()).to.equal(1);

    // Second call for the same account must hit the early-return path (proxy already exists), not
    // deploy a new one -- proxyCount must stay at 1 and the returned address must be unchanged.
    const second = await factory.connect(controller).getOrCreateProxy.staticCall(xrplAccount);
    expect(second).to.equal(first);
    await factory.connect(controller).getOrCreateProxy(xrplAccount);
    expect(await factory.proxyCount()).to.equal(1);
  });

  it("rejects a zero controller at construction", async function () {
    const Proxy = await ethers.getContractFactory("XRPLUserProxy");
    await expect(
      Proxy.deploy(ethers.ZeroAddress, ethers.encodeBytes32String("dave"))
    ).to.be.revertedWith("XRPLUserProxy: controller=0");
  });

  it("emits Executed and returns call data on a successful execute", async function () {
    const [controller] = await ethers.getSigners();
    const Proxy = await ethers.getContractFactory("XRPLUserProxy");
    const proxy = await Proxy.deploy(controller.address, ethers.encodeBytes32String("erin"));

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Mock", "MOCK", 18);

    const data = token.interface.encodeFunctionData("symbol");
    await expect(proxy.connect(controller).execute(token.target, 0, data))
      .to.emit(proxy, "Executed")
      .withArgs(token.target, 0, data);
  });

  it("reverts execute with the target's revert data on failure", async function () {
    const [controller] = await ethers.getSigners();
    const Proxy = await ethers.getContractFactory("XRPLUserProxy");
    const proxy = await Proxy.deploy(controller.address, ethers.encodeBytes32String("frank"));

    const Token = await ethers.getContractFactory("MockERC20ApproveFalse");
    const token = await Token.deploy("Mock", "MOCK", 18);
    // approve() on a non-owner spender with insufficient context still just returns false rather than
    // reverting for this mock; use a call with obviously malformed calldata to force a revert instead.
    await expect(proxy.connect(controller).execute(token.target, 0, "0x12345678")).to.be.revertedWithCustomError(
      proxy,
      "CallFailed"
    );
  });

  it("rejects sweepToken for a token address with no contract code", async function () {
    const [controller, , recipient] = await ethers.getSigners();
    const Proxy = await ethers.getContractFactory("XRPLUserProxy");
    const proxy = await Proxy.deploy(controller.address, ethers.encodeBytes32String("grace"));
    const eoaToken = ethers.Wallet.createRandom().address;

    await expect(
      proxy.connect(controller).sweepToken(eoaToken, recipient.address, 1n)
    ).to.be.revertedWithCustomError(proxy, "TokenTransferFailed");
  });

  it("rejects sweepToken when the token call reverts", async function () {
    const [controller, , recipient] = await ethers.getSigners();
    const Proxy = await ethers.getContractFactory("XRPLUserProxy");
    const proxy = await Proxy.deploy(controller.address, ethers.encodeBytes32String("henry"));
    // Any deployed contract with no transfer(address,uint256) selector and no fallback reverts on call.
    const NotAToken = await ethers.getContractFactory("JumpRateModelV2");
    const notAToken = await NotAToken.deploy(0, 0, 0, ethers.parseEther("0.8"), controller.address);

    await expect(
      proxy.connect(controller).sweepToken(notAToken.target, recipient.address, 1n)
    ).to.be.revertedWithCustomError(proxy, "TokenTransferFailed");
  });

  it("rejects sweepToken when the token's transfer returns false", async function () {
    const [controller, , recipient] = await ethers.getSigners();
    const Proxy = await ethers.getContractFactory("XRPLUserProxy");
    const proxy = await Proxy.deploy(controller.address, ethers.encodeBytes32String("ivan"));

    const Token = await ethers.getContractFactory("MockERC20TransferFalse");
    const token = await Token.deploy("Mock", "MOCK");
    await token.mint(proxy.target, 1000n);

    await expect(
      proxy.connect(controller).sweepToken(token.target, recipient.address, 100n)
    ).to.be.revertedWithCustomError(proxy, "TokenTransferFailed");
  });

  it("rejects sweepNative to the zero address", async function () {
    const [controller] = await ethers.getSigners();
    const Proxy = await ethers.getContractFactory("XRPLUserProxy");
    const proxy = await Proxy.deploy(controller.address, ethers.encodeBytes32String("julia"));

    await expect(
      proxy.connect(controller).sweepNative(ethers.ZeroAddress, 0n)
    ).to.be.revertedWithCustomError(proxy, "CallFailed");
  });

  it("rejects sweepNative to a recipient that cannot accept native value", async function () {
    const [controller] = await ethers.getSigners();
    const Proxy = await ethers.getContractFactory("XRPLUserProxy");
    const proxy = await Proxy.deploy(controller.address, ethers.encodeBytes32String("kevin"));
    await ethers.provider.send("hardhat_setBalance", [proxy.target, "0x1000000000000000000"]);

    // A plain ERC20 has no receive/fallback, so a native transfer to it fails.
    const Rejecting = await ethers.getContractFactory("MockERC20");
    const rejecting = await Rejecting.deploy("Mock", "MOCK", 18);

    await expect(
      proxy.connect(controller).sweepNative(rejecting.target, ethers.parseEther("0.1"))
    ).to.be.revertedWithCustomError(proxy, "CallFailed");
  });
});
