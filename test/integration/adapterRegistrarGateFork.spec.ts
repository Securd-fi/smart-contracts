// @ts-nocheck
/**
 * Forked-mainnet integration test for XRPLAdapterRegistrarGate.
 *
 * Unlike adapterRegistrarGate.spec.ts (which deploys a fresh mock adapter), this test runs the gate
 * against the REAL, already-deployed, already-configured mainnet XRPLSecurdBridgeAdapter -- forked at
 * the current block via hardhat_reset, with the real owner impersonated. Nothing here touches real
 * mainnet; every state change happens only on the local fork and is discarded when the test ends.
 *
 * This exists specifically to catch anything a synthetic fixture could miss: real existing market
 * configs, a real already-registered account, the real egressGasValue, the real owner address --
 * proving the gate integrates cleanly with the actual production state, not just a clean-room mock.
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";

const REAL_ADAPTER = "0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848";
const REAL_OWNER = "0x57eb9411CA49752994b81cd1B60c3917Cb99247C";
const REAL_SUSDC_MARKET = "0x21Da09A16d69757C0731De3b83e65061BCF30E00";
const REAL_SUSDC_UNDERLYING = "0xa16148c6Ac9EDe0D82f0c52899e22a575284f131";
// Already registered on real mainnet (our own test account, used throughout this project's live testing).
const ALREADY_REGISTERED_XRPL_ADDR = "rPAdN2a4qHwVoFG8b6mthGeqo5UfMHjNTp";
// The developer's wallet, requested for registration, NOT yet registered as of writing this test.
const DEVELOPER_XRPL_ADDR = "rPpamGtvayxx97LcxM7dWhBSJsPCzdUCAB";
const PROPOSED_REGISTRAR = "0x19A5F20d83336A4AAF133B0fE617798cC4F6C99b";

describe("XRPLAdapterRegistrarGate — forked mainnet integration", function () {
  this.timeout(120_000);

  let ownerSigner: any;
  let adapter: any;

  before(async function () {
    if (!process.env.XRPL_EVM_MAINNET_FORK_RPC) {
      console.log("Skipping: set XRPL_EVM_MAINNET_FORK_RPC and run with --network hardhat to fork mainnet.");
      this.skip();
    }
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [REAL_OWNER] });
    await network.provider.request({ method: "hardhat_setBalance", params: [REAL_OWNER, "0x56BC75E2D63100000"] }); // 100 ETH-equivalent
    ownerSigner = await ethers.getSigner(REAL_OWNER);
    adapter = await ethers.getContractAt("XRPLSecurdBridgeAdapter", REAL_ADAPTER);
  });

  it("sanity: the fork actually sees real mainnet state before anything is touched", async function () {
    expect(await adapter.owner()).to.equal(REAL_OWNER);
    const cfg = await adapter.marketConfigOf(REAL_SUSDC_MARKET);
    expect(cfg.underlying.toLowerCase()).to.equal(REAL_SUSDC_UNDERLYING.toLowerCase());
    expect(cfg.listed).to.equal(true);

    const alreadyRegisteredAccount = ethers.keccak256(ethers.toUtf8Bytes(ALREADY_REGISTERED_XRPL_ADDR));
    const existingSigner = await adapter.intentSignerOfXrplAccount(alreadyRegisteredAccount);
    expect(existingSigner).to.not.equal(ethers.ZeroAddress);

    const devAccount = ethers.keccak256(ethers.toUtf8Bytes(DEVELOPER_XRPL_ADDR));
    expect(await adapter.intentSignerOfXrplAccount(devAccount)).to.equal(ethers.ZeroAddress);
  });

  it("deploying the gate and transferring real adapter ownership preserves every existing setting untouched", async function () {
    const egressGasValueBefore = await adapter.egressGasValue();
    const destinationChainBefore = await adapter.destinationChain();
    const susdcConfigBefore = await adapter.marketConfigOf(REAL_SUSDC_MARKET);
    const alreadyRegisteredAccount = ethers.keccak256(ethers.toUtf8Bytes(ALREADY_REGISTERED_XRPL_ADDR));
    const existingSignerBefore = await adapter.intentSignerOfXrplAccount(alreadyRegisteredAccount);

    const Gate = await ethers.getContractFactory("XRPLAdapterRegistrarGate");
    const gate = await Gate.connect(ownerSigner).deploy(REAL_OWNER, REAL_ADAPTER, PROPOSED_REGISTRAR, PROPOSED_REGISTRAR);
    await gate.waitForDeployment();

    await adapter.connect(ownerSigner).transferOwnership(gate.target);

    expect(await adapter.owner()).to.equal(gate.target);
    // Nothing else on the real, already-configured adapter moved.
    expect(await adapter.egressGasValue()).to.equal(egressGasValueBefore);
    expect(await adapter.destinationChain()).to.equal(destinationChainBefore);
    const susdcConfigAfter = await adapter.marketConfigOf(REAL_SUSDC_MARKET);
    expect(susdcConfigAfter.underlying).to.equal(susdcConfigBefore.underlying);
    expect(susdcConfigAfter.tokenId).to.equal(susdcConfigBefore.tokenId);
    expect(susdcConfigAfter.listed).to.equal(susdcConfigBefore.listed);
    expect(await adapter.intentSignerOfXrplAccount(alreadyRegisteredAccount)).to.equal(existingSignerBefore);

    this.gate = gate; // handed to subsequent tests in this file via shared `this`
  });

  it("registerAccount against the real adapter correctly onboards the developer's actual wallet", async function () {
    const Gate = await ethers.getContractFactory("XRPLAdapterRegistrarGate");
    const gateAddress = await (await adapter.owner());
    const gate = Gate.attach(gateAddress);
    const registrarSigner = await ethers.getImpersonatedSigner(PROPOSED_REGISTRAR);
    await network.provider.send("hardhat_setBalance", [PROPOSED_REGISTRAR, "0x56BC75E2D63100000"]);

    const tx = await gate.connect(registrarSigner).registerAccount(DEVELOPER_XRPL_ADDR);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);

    const devAccount = ethers.keccak256(ethers.toUtf8Bytes(DEVELOPER_XRPL_ADDR));
    expect(await adapter.intentSignerOfXrplAccount(devAccount)).to.equal(PROPOSED_REGISTRAR);

    const itsId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes"], ["xrpl", ethers.toUtf8Bytes(DEVELOPER_XRPL_ADDR)])
    );
    const gmpId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["string", "string"], ["xrpl", DEVELOPER_XRPL_ADDR])
    );
    expect(await adapter.trustedItsSource(itsId)).to.equal(true);
    expect(await adapter.trustedGmpSource(gmpId)).to.equal(true);
  });

  it("re-registering an account already set on real mainnet (not via the gate) is a safe, idempotent no-op", async function () {
    const gateAddress = await adapter.owner();
    const Gate = await ethers.getContractFactory("XRPLAdapterRegistrarGate");
    const gate = Gate.attach(gateAddress);
    const registrarSigner = await ethers.getImpersonatedSigner(PROPOSED_REGISTRAR);

    const alreadyRegisteredAccount = ethers.keccak256(ethers.toUtf8Bytes(ALREADY_REGISTERED_XRPL_ADDR));
    const realSignerBefore = await adapter.intentSignerOfXrplAccount(alreadyRegisteredAccount);
    expect(realSignerBefore).to.not.equal(ethers.ZeroAddress);
    expect(realSignerBefore).to.not.equal(PROPOSED_REGISTRAR); // real account was registered with a different signer

    await expect(gate.connect(registrarSigner).registerAccount(ALREADY_REGISTERED_XRPL_ADDR))
      .to.emit(gate, "AccountRegistered")
      .withArgs(alreadyRegisteredAccount, ALREADY_REGISTERED_XRPL_ADDR, false, false, false);

    // Critically: the gate must NOT have overwritten the real, pre-existing signer for this account.
    expect(await adapter.intentSignerOfXrplAccount(alreadyRegisteredAccount)).to.equal(realSignerBefore);
  });

  it("adminCall reaches the real adapter's owner-only surface exactly as a direct owner call would", async function () {
    const gateAddress = await adapter.owner();
    const Gate = await ethers.getContractFactory("XRPLAdapterRegistrarGate");
    const gate = Gate.attach(gateAddress);

    const before = await adapter.egressGasValue();
    const probe = before + ethers.parseEther("0.01");
    const data = adapter.interface.encodeFunctionData("setEgressGasValue", [probe]);
    await gate.connect(ownerSigner).adminCall(data);
    expect(await adapter.egressGasValue()).to.equal(probe);

    // Restore, proving the path is fully general (any owner call), not special-cased.
    const restoreData = adapter.interface.encodeFunctionData("setEgressGasValue", [before]);
    await gate.connect(ownerSigner).adminCall(restoreData);
    expect(await adapter.egressGasValue()).to.equal(before);
  });

  after(async function () {
    if (!process.env.XRPL_EVM_MAINNET_FORK_RPC) return;
    await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [REAL_OWNER] });
  });
});
