/**
 * Deploys XRPLAdapterRegistrarGate and, optionally, transfers the bridge adapter's ownership to it.
 *
 * This is a two-phase, deliberately separated script because the adapter uses single-step OpenZeppelin
 * Ownable: transferOwnership takes effect immediately, with no acceptance step and no way to undo a mistake.
 * Phase 1 (deploy) is cheap to re-run if anything looks wrong. Phase 2 (transfer) is not reversible except
 * by calling adminCall(transferOwnership(...)) through the very gate you're about to depend on -- so it is
 * gated behind an explicit confirmation flag and a pre-flight check that the connected signer is in fact
 * the adapter's current owner, not assumed.
 *
 * Required env vars:
 *   XRPL_EVM_RPC_URL              XRPL EVM RPC endpoint
 *   DEPLOYER_PRIVATE_KEY          Must be the adapter's CURRENT owner (DEPLOY_OWNER) -- verified live, not assumed
 *   GATE_ADAPTER_ADDRESS          XRPLSecurdBridgeAdapter address
 *   GATE_BACKEND_SIGNER           Fixed intent-signer address used for every registration via the gate
 *
 * Optional:
 *   GATE_REGISTRAR                Initial registrar address (default: address(0), set later via setRegistrar)
 *   GATE_CONFIRM_TRANSFER_OWNERSHIP   Set to "true" to also transfer adapter ownership to the gate in this run
 *   SECURD_EXPECTED_CHAIN_ID       If set, asserted against the live RPC's chain id before anything is sent
 */
import { ethers } from "hardhat";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value.trim();
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

async function main() {
  const adapterAddress = requiredEnv("GATE_ADAPTER_ADDRESS");
  const backendSigner = requiredEnv("GATE_BACKEND_SIGNER");
  const registrar = optionalEnv("GATE_REGISTRAR", ethers.ZeroAddress);
  const confirmTransfer = process.env.GATE_CONFIRM_TRANSFER_OWNERSHIP === "true";

  if (!ethers.isAddress(adapterAddress)) throw new Error(`GATE_ADAPTER_ADDRESS is not a valid address: ${adapterAddress}`);
  if (!ethers.isAddress(backendSigner) || backendSigner === ethers.ZeroAddress) {
    throw new Error(`GATE_BACKEND_SIGNER must be a non-zero address: ${backendSigner}`);
  }
  if (!ethers.isAddress(registrar)) throw new Error(`GATE_REGISTRAR is not a valid address: ${registrar}`);

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  const expectedChainId = process.env.SECURD_EXPECTED_CHAIN_ID;
  if (expectedChainId && network.chainId !== BigInt(expectedChainId)) {
    throw new Error(`Connected chain id ${network.chainId} does not match SECURD_EXPECTED_CHAIN_ID=${expectedChainId}`);
  }

  const adapter = await ethers.getContractAt("XRPLSecurdBridgeAdapter", adapterAddress);
  const currentOwner: string = await adapter.owner();

  console.log(JSON.stringify({
    phase: "pre-flight",
    chainId: network.chainId.toString(),
    signer: signer.address,
    adapterAddress,
    adapterCurrentOwner: currentOwner,
    signerIsCurrentOwner: currentOwner.toLowerCase() === signer.address.toLowerCase(),
    backendSigner,
    registrar,
    willTransferOwnershipThisRun: confirmTransfer,
  }, null, 2));

  if (confirmTransfer && currentOwner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Refusing to deploy with transfer confirmed: connected signer ${signer.address} is not the adapter's ` +
      `current owner (${currentOwner}). Fix DEPLOYER_PRIVATE_KEY or drop GATE_CONFIRM_TRANSFER_OWNERSHIP.`
    );
  }

  console.log("\nDeploying XRPLAdapterRegistrarGate...");
  const Gate = await ethers.getContractFactory("XRPLAdapterRegistrarGate");
  const gate = await Gate.deploy(signer.address, adapterAddress, registrar, backendSigner);
  await gate.waitForDeployment();
  const gateAddress = await gate.getAddress();
  console.log(`XRPLAdapterRegistrarGate deployed at: ${gateAddress}`);

  // Read back every configured value from the freshly deployed contract -- never assume the constructor
  // args landed as intended.
  console.log(JSON.stringify({
    phase: "post-deploy verification",
    gateAddress,
    "gate.owner()": await gate.owner(),
    "gate.registrar()": await gate.registrar(),
    "gate.backendSigner()": await gate.backendSigner(),
    "gate.ADAPTER()": await gate.ADAPTER(),
    "gate.paused()": await gate.paused(),
  }, null, 2));

  if (!confirmTransfer) {
    console.log(
      "\nGATE_CONFIRM_TRANSFER_OWNERSHIP was not set to \"true\" -- the adapter's ownership was NOT touched. " +
      `The adapter owner is still ${currentOwner}. The gate above is deployed but inert until ownership is ` +
      "transferred to it in a separate, deliberate run."
    );
    return;
  }

  console.log(`\nTransferring adapter ownership from ${currentOwner} to the gate (${gateAddress})...`);
  const tx = await adapter.connect(signer).transferOwnership(gateAddress);
  console.log(`Transaction sent: ${tx.hash}`);
  await tx.wait();

  const newOwner: string = await adapter.owner();
  console.log(JSON.stringify({
    phase: "post-transfer verification",
    adapterOwnerNow: newOwner,
    transferSucceeded: newOwner.toLowerCase() === gateAddress.toLowerCase(),
  }, null, 2));

  if (newOwner.toLowerCase() !== gateAddress.toLowerCase()) {
    throw new Error(
      `CRITICAL: adapter.owner() reads ${newOwner} after the transfer transaction, not the gate address ` +
      `${gateAddress}. Investigate immediately before relying on this deployment.`
    );
  }

  console.log(
    "\nDone. The adapter is now owned by the gate. All existing owner-only adapter calls must go through " +
    "gate.adminCall(data) from here on -- direct calls to the adapter with the old owner key will revert. " +
    (registrar === ethers.ZeroAddress
      ? "No registrar is set yet -- call gate.setRegistrar(address) before any registration can happen."
      : `Registrar ${registrar} can now call gate.registerAccount(xrplAddress).`)
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
