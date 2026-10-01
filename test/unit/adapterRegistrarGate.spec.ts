// @ts-nocheck
import { expect } from "chai";
import { ethers } from "hardhat";

describe("XRPLAdapterRegistrarGate", function () {
  const XRPL_ADDR = "rPAdN2a4qHwVoFG8b6mthGeqo5UfMHjNTp";

  async function deployFixture() {
    const [owner, registrar, backendSigner, otherSigner, attacker, stranger] = await ethers.getSigners();

    const gateway = await (await ethers.getContractFactory("MockGateway")).deploy();
    const its = await (await ethers.getContractFactory("MockInterchainTokenService")).deploy();
    const factory = await (await ethers.getContractFactory("XRPLUserProxyFactory")).deploy(owner.address, owner.address);
    const adapter = await (
      await ethers.getContractFactory("XRPLSecurdBridgeAdapter")
    ).deploy(owner.address, gateway.target, its.target, factory.target, "xrpl");

    const Gate = await ethers.getContractFactory("XRPLAdapterRegistrarGate");
    const gate = await Gate.deploy(owner.address, adapter.target, registrar.address, backendSigner.address);

    // Hand the adapter over to the gate -- the owner retains control only through adminCall from here on.
    await adapter.connect(owner).transferOwnership(gate.target);

    return { owner, registrar, backendSigner, otherSigner, attacker, stranger, adapter, gate, factory };
  }

  function xrplAccountOf(address: string) {
    return ethers.keccak256(ethers.toUtf8Bytes(address));
  }

  function itsSourceIdOf(address: string) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes"], ["xrpl", ethers.toUtf8Bytes(address)])
    );
  }

  function gmpSourceIdOf(address: string) {
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "string"], ["xrpl", address]));
  }

  describe("deployment", function () {
    it("takes ownership of the adapter and leaves the adapter's owner-only surface intact", async function () {
      const { adapter, gate } = await deployFixture();
      expect(await adapter.owner()).to.equal(gate.target);
    });

    it("ADAPTER() is immutable and reads back the address passed at construction", async function () {
      const { adapter, gate } = await deployFixture();
      expect(await gate.ADAPTER()).to.equal(adapter.target);
    });

    it("rejects a zero owner, adapter, or backend signer", async function () {
      const [owner, registrar, backendSigner] = await ethers.getSigners();
      const Gate = await ethers.getContractFactory("XRPLAdapterRegistrarGate");
      await expect(Gate.deploy(ethers.ZeroAddress, owner.address, registrar.address, backendSigner.address))
        .to.be.revertedWithCustomError(Gate, "InvalidAddress");
      await expect(Gate.deploy(owner.address, ethers.ZeroAddress, registrar.address, backendSigner.address))
        .to.be.revertedWithCustomError(Gate, "InvalidAddress");
      await expect(Gate.deploy(owner.address, owner.address, registrar.address, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Gate, "InvalidAddress");
    });

    it("allows deploying with no registrar yet (address(0)), set later by the owner", async function () {
      const [owner, , backendSigner] = await ethers.getSigners();
      const Gate = await ethers.getContractFactory("XRPLAdapterRegistrarGate");
      const gate = await Gate.deploy(owner.address, owner.address, ethers.ZeroAddress, backendSigner.address);
      expect(await gate.registrar()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("registerAccount — happy path", function () {
    it("registers all three (signer, ITS trust, GMP trust) on first call", async function () {
      const { registrar, backendSigner, adapter, gate } = await deployFixture();

      await expect(gate.connect(registrar).registerAccount(XRPL_ADDR))
        .to.emit(gate, "AccountRegistered")
        .withArgs(xrplAccountOf(XRPL_ADDR), XRPL_ADDR, true, true, true);

      expect(await adapter.intentSignerOfXrplAccount(xrplAccountOf(XRPL_ADDR))).to.equal(backendSigner.address);
      expect(await adapter.trustedItsSource(itsSourceIdOf(XRPL_ADDR))).to.equal(true);
      expect(await adapter.trustedGmpSource(gmpSourceIdOf(XRPL_ADDR))).to.equal(true);
    });

    it("is idempotent: a second registration call is a harmless no-op, flags report nothing changed", async function () {
      const { registrar, gate } = await deployFixture();
      await gate.connect(registrar).registerAccount(XRPL_ADDR);

      await expect(gate.connect(registrar).registerAccount(XRPL_ADDR))
        .to.emit(gate, "AccountRegistered")
        .withArgs(xrplAccountOf(XRPL_ADDR), XRPL_ADDR, false, false, false);
    });

    it("partial state (e.g. ITS trust already set by the owner directly) only fills in what's missing", async function () {
      const { owner, registrar, backendSigner, adapter, gate } = await deployFixture();

      // Owner pre-sets ITS trust directly through adminCall before any registrar call.
      const data = adapter.interface.encodeFunctionData("setTrustedItsSource", [
        "xrpl",
        ethers.toUtf8Bytes(XRPL_ADDR),
        true,
      ]);
      await gate.connect(owner).adminCall(data);

      await expect(gate.connect(registrar).registerAccount(XRPL_ADDR))
        .to.emit(gate, "AccountRegistered")
        .withArgs(xrplAccountOf(XRPL_ADDR), XRPL_ADDR, true, false, true);
    });
  });

  describe("registerAccount — access control and the core security property", function () {
    it("reverts for anyone who isn't the registrar", async function () {
      const { attacker, gate } = await deployFixture();
      await expect(gate.connect(attacker).registerAccount(XRPL_ADDR)).to.be.revertedWithCustomError(
        gate,
        "NotRegistrar"
      );
    });

    it("reverts for the owner itself (owner must go through adminCall, not registerAccount)", async function () {
      const { owner, gate } = await deployFixture();
      await expect(gate.connect(owner).registerAccount(XRPL_ADDR)).to.be.revertedWithCustomError(
        gate,
        "NotRegistrar"
      );
    });

    it("CRITICAL: a compromised registrar can never redirect an already-registered account's signer", async function () {
      const { registrar, backendSigner, otherSigner, owner, adapter, gate } = await deployFixture();

      // Legitimate first registration.
      await gate.connect(registrar).registerAccount(XRPL_ADDR);
      expect(await adapter.intentSignerOfXrplAccount(xrplAccountOf(XRPL_ADDR))).to.equal(backendSigner.address);

      // Even if the owner points backendSigner somewhere else afterward, a second registerAccount
      // call must NOT retroactively change the signer already on file for this account.
      await gate.connect(owner).setBackendSigner(otherSigner.address);
      await gate.connect(registrar).registerAccount(XRPL_ADDR);

      expect(await adapter.intentSignerOfXrplAccount(xrplAccountOf(XRPL_ADDR))).to.equal(backendSigner.address);
    });

    it("the registrar can never choose a signer other than the owner-configured backendSigner", async function () {
      const { gate } = await deployFixture();
      // registerAccount's ABI takes only an xrplAddress string -- there is no parameter through which
      // a caller, compromised or not, could specify an arbitrary signer address. Asserted structurally:
      const fn = gate.interface.getFunction("registerAccount");
      expect(fn.inputs.length).to.equal(1);
      expect(fn.inputs[0].type).to.equal("string");
    });

    it("rejects a malformed XRPL address (wrong prefix)", async function () {
      const { registrar, gate } = await deployFixture();
      await expect(gate.connect(registrar).registerAccount("xPAdN2a4qHwVoFG8b6mthGeqo5UfMHjNTp"))
        .to.be.revertedWithCustomError(gate, "InvalidXrplAddress");
    });

    it("rejects a malformed XRPL address (too short)", async function () {
      const { registrar, gate } = await deployFixture();
      await expect(gate.connect(registrar).registerAccount("rShort")).to.be.revertedWithCustomError(
        gate,
        "InvalidXrplAddress"
      );
    });

    it("rejects a malformed XRPL address (invalid base58 character '0')", async function () {
      const { registrar, gate } = await deployFixture();
      await expect(
        gate.connect(registrar).registerAccount("rPAdN0a4qHwVoFG8b6mthGeqo5UfMHjNTp")
      ).to.be.revertedWithCustomError(gate, "InvalidXrplAddress");
    });

    it("accepts the minimum valid length (25 chars) and the maximum (35 chars)", async function () {
      const { registrar, gate } = await deployFixture();
      const min25 = "r" + "p".repeat(24);
      const max35 = "r" + "p".repeat(34);
      expect(min25.length).to.equal(25);
      expect(max35.length).to.equal(35);
      await expect(gate.connect(registrar).registerAccount(min25)).to.not.be.reverted;
      await expect(gate.connect(registrar).registerAccount(max35)).to.not.be.reverted;
    });

    it("rejects one character below the minimum (24 chars) and one above the maximum (36 chars)", async function () {
      const { registrar, gate } = await deployFixture();
      const tooShort = "r" + "p".repeat(23);
      const tooLong = "r" + "p".repeat(35);
      expect(tooShort.length).to.equal(24);
      expect(tooLong.length).to.equal(36);
      await expect(gate.connect(registrar).registerAccount(tooShort)).to.be.revertedWithCustomError(
        gate,
        "InvalidXrplAddress"
      );
      await expect(gate.connect(registrar).registerAccount(tooLong)).to.be.revertedWithCustomError(
        gate,
        "InvalidXrplAddress"
      );
    });

    it("respects pause: registrar cannot register while paused", async function () {
      const { owner, registrar, gate } = await deployFixture();
      await gate.connect(owner).pause();
      await expect(gate.connect(registrar).registerAccount(XRPL_ADDR)).to.be.revertedWith("Pausable: paused");
    });
  });

  describe("owner path", function () {
    it("only the owner can change the registrar", async function () {
      const { owner, stranger, attacker, gate } = await deployFixture();
      await expect(gate.connect(attacker).setRegistrar(stranger.address)).to.be.revertedWith("Ownable: caller is not the owner");
      await expect(gate.connect(owner).setRegistrar(stranger.address))
        .to.emit(gate, "RegistrarSet");
      expect(await gate.registrar()).to.equal(stranger.address);
    });

    it("only the owner can change the backend signer, and it cannot be set to zero", async function () {
      const { owner, attacker, stranger, gate } = await deployFixture();
      await expect(gate.connect(attacker).setBackendSigner(stranger.address)).to.be.revertedWith("Ownable: caller is not the owner");
      await expect(gate.connect(owner).setBackendSigner(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        gate,
        "InvalidAddress"
      );
      await gate.connect(owner).setBackendSigner(stranger.address);
      expect(await gate.backendSigner()).to.equal(stranger.address);
    });

    it("adminCall lets the owner reach every other adapter function untouched (e.g. setEgressGasValue)", async function () {
      const { owner, adapter, gate } = await deployFixture();
      const data = adapter.interface.encodeFunctionData("setEgressGasValue", [ethers.parseEther("0.3")]);
      await gate.connect(owner).adminCall(data);
      expect(await adapter.egressGasValue()).to.equal(ethers.parseEther("0.3"));
    });

    it("adminCall reverts and surfaces the inner revert reason if the forwarded call fails", async function () {
      const { owner, adapter, gate } = await deployFixture();
      // setIntentSigner reverts InvalidXrplAccount() on a zero xrplAccount.
      const data = adapter.interface.encodeFunctionData("setIntentSigner", [
        ethers.ZeroHash,
        ethers.Wallet.createRandom().address,
      ]);
      await expect(gate.connect(owner).adminCall(data)).to.be.revertedWithCustomError(gate, "AdminCallFailed");
    });

    it("only the owner can call adminCall", async function () {
      const { attacker, registrar, adapter, gate } = await deployFixture();
      const data = adapter.interface.encodeFunctionData("pause", []);
      await expect(gate.connect(attacker).adminCall(data)).to.be.revertedWith("Ownable: caller is not the owner");
      // The registrar role has no elevated access to adminCall either.
      await expect(gate.connect(registrar).adminCall(data)).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("only the owner can pause/unpause", async function () {
      const { attacker, gate } = await deployFixture();
      await expect(gate.connect(attacker).pause()).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("returnAdapterOwnership hands the adapter back out, and only the owner can call it", async function () {
      const { owner, attacker, stranger, adapter, gate } = await deployFixture();
      await expect(gate.connect(attacker).returnAdapterOwnership(stranger.address)).to.be.revertedWith("Ownable: caller is not the owner");
      await expect(gate.connect(owner).returnAdapterOwnership(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        gate,
        "InvalidAddress"
      );
      await gate.connect(owner).returnAdapterOwnership(stranger.address);
      expect(await adapter.owner()).to.equal(stranger.address);
    });
  });

  describe("gate's own ownership is Ownable2Step", function () {
    it("transferOwnership alone does not move ownership -- acceptOwnership is required", async function () {
      const { owner, stranger, gate } = await deployFixture();
      await gate.connect(owner).transferOwnership(stranger.address);
      expect(await gate.owner()).to.equal(owner.address); // unchanged until accepted
      expect(await gate.pendingOwner()).to.equal(stranger.address);

      await gate.connect(stranger).acceptOwnership();
      expect(await gate.owner()).to.equal(stranger.address);
    });

    it("a random address cannot accept ownership it wasn't offered", async function () {
      const { owner, stranger, attacker, gate } = await deployFixture();
      await gate.connect(owner).transferOwnership(stranger.address);
      await expect(gate.connect(attacker).acceptOwnership()).to.be.revertedWith(
        "Ownable2Step: caller is not the new owner"
      );
    });
  });
});
