/**
 * Executes the queued collateral-factor change for sXRPUSDCLP (35%), signed by the
 * protocol owner, through SecurdCollateralFactorTimelock.
 *
 * Action: _setCollateralFactor(sXRPUSDCLP, 0.35e18)
 * Action id: 0xec8f338772b22bdaf0df1ed0aa305a9e00974d18c57a990f3de4c74eaecae9bb
 * Eta: 2026-10-07 11:34:11 UTC. Grace period ends 2026-10-14 11:34:11 UTC.
 *
 * Key handling:
 *   - The key is read from OWNER_PRIVATE_KEY in a local, gitignored env file.
 *   - Run with: set -a; . ./.env.mainnet.owner-key; set +a; CONFIRM_EXECUTE_CF=true npx ts-node scripts/runOwnerExecuteCollateralFactor.ts
 *
 * Safety:
 *   - Refuses to run unless CONFIRM_EXECUTE_CF=true.
 *   - Refuses to run unless the key's address equals the timelock's owner().
 *   - Refuses to run unless the chain time is at or after the action's eta.
 *   - Refuses to run unless the LP oracle price is non-zero and less than 900 seconds old.
 *   - Refuses to run if the LP collateral factor is already 0.35e18 (nothing to do).
 *   - Reads the collateral factor back after sending and fails if it does not match.
 */
import { ethers } from "ethers";

const TIMELOCK = "0xEB27E14a7E7Dd1652FBC6220df56F28a6b1047Fb";
const COMPTROLLER = "0xf2631D04bf1E568c777e822213040785B968405E";
const ORACLE = "0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98";
const SXRPUSDCLP = "0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F";
const LP_TOKEN = "0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53";
const ACTION_ID = "0xec8f338772b22bdaf0df1ed0aa305a9e00974d18c57a990f3de4c74eaecae9bb";
const TARGET_CF = 350000000000000000n; // 0.35e18
const MAX_PRICE_AGE_SEC = 900n;
const EXPECTED_CHAIN_ID = 1440000n;

const TIMELOCK_ABI = [
  "function owner() view returns (address)",
  "function queuedActions(bytes32) view returns (address target, uint256 value, bytes data, uint256 eta, bool exists)",
  "function execute(bytes32 actionId)"
];
const COMPTROLLER_ABI = ["function markets(address) view returns (bool isListed, uint256 collateralFactorMantissa, bool isComped)"];
const ORACLE_ABI = ["function fallbackPriceOf(address) view returns (uint256 priceMantissa, uint256 updatedAt)"];

async function main(): Promise<void> {
  if (process.env.CONFIRM_EXECUTE_CF !== "true") {
    throw new Error("Set CONFIRM_EXECUTE_CF=true to send the transaction.");
  }
  const rawKey = process.env.OWNER_PRIVATE_KEY;
  if (!rawKey) {
    throw new Error("OWNER_PRIVATE_KEY is not set. Load it from a local, gitignored env file first.");
  }

  const rpcUrl = process.env.XRPL_EVM_RPC_URL ?? "https://rpc.xrplevm.org";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`RPC chain id is ${network.chainId}, expected ${EXPECTED_CHAIN_ID}. Refusing to continue.`);
  }

  const wallet = new ethers.Wallet(rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`, provider);
  const timelock = new ethers.Contract(TIMELOCK, TIMELOCK_ABI, wallet);
  const comptroller = new ethers.Contract(COMPTROLLER, COMPTROLLER_ABI, provider);
  const oracle = new ethers.Contract(ORACLE, ORACLE_ABI, provider);

  const owner = await timelock.owner();
  if (wallet.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Key address ${wallet.address} is not the timelock owner ${owner}. Refusing to send.`);
  }

  const action = await timelock.queuedActions(ACTION_ID);
  if (!action.exists) {
    throw new Error("Action is not queued (already executed, cancelled, or wrong id).");
  }

  const latestBlock = await provider.getBlock("latest");
  const now = BigInt(latestBlock!.timestamp);
  if (now < action.eta) {
    throw new Error(`Too early: eta is ${new Date(Number(action.eta) * 1000).toISOString()}, now is ${new Date(Number(now) * 1000).toISOString()}.`);
  }

  const [priceMantissa, updatedAt] = await oracle.fallbackPriceOf(LP_TOKEN);
  if (priceMantissa === 0n) {
    throw new Error("LP oracle price is zero. The Comptroller will reject this with PRICE_ERROR. Not sending.");
  }
  const age = now - BigInt(updatedAt);
  if (age > MAX_PRICE_AGE_SEC) {
    throw new Error(`LP oracle price is ${age}s old, above the ${MAX_PRICE_AGE_SEC}s staleness limit. Not sending.`);
  }
  console.log(`LP price $${(Number(priceMantissa) / 1e18).toFixed(8)}, age ${age}s. OK.`);

  const before = await comptroller.markets(SXRPUSDCLP);
  if (before.collateralFactorMantissa === TARGET_CF) {
    console.log("[skip] collateral factor is already 0.35e18. Nothing to do.");
    return;
  }

  const tx = await timelock.execute(ACTION_ID);
  console.log(`[sent] execute(${ACTION_ID}): ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Execution failed: tx ${tx.hash} status ${receipt?.status}`);
  }

  const after = await comptroller.markets(SXRPUSDCLP);
  if (after.collateralFactorMantissa !== TARGET_CF) {
    throw new Error(`Transaction succeeded but collateral factor is ${after.collateralFactorMantissa}, not ${TARGET_CF}.`);
  }
  console.log(`[ok] collateral factor is now 0.35e18, confirmed in block ${receipt.blockNumber}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
