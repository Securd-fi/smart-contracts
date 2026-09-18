/**
 * Applies per-market reserve factor and interest-rate-model curves after deployment.
 *
 * Why this script exists: deploySecurdStack.ts deploys ONE shared JumpRateModelV2 and
 * assigns it to every market, and never calls _setReserveFactor at all (every market's
 * reserveFactorMantissa stays at the CToken default of 0). Neither matches the per-asset
 * values in docs/securd-asset-listing-risk-parameters.md. This generalizes the pattern
 * already proven ad hoc in deployAndAssignSeparateIRMs.ts (which hardcoded testnet's two
 * markets) into a config-driven script for any market set.
 *
 * Both _setInterestRateModel and _setReserveFactor are gated `msg.sender == admin`
 * (CToken.sol), and cToken admin is the final DEPLOY_OWNER set at construction time --
 * NOT the deployer key. If DEPLOY_OWNER is a multisig, use --print-calldata and submit
 * the encoded calls through your multisig UI instead of direct-send.
 *
 * Required env vars: XRPL_EVM_RPC_URL, DEPLOYMENT_RECORD_FILE
 * Optional env vars: DEPLOYER_PRIVATE_KEY (only needed for direct-send mode),
 *                     MARKET_RISK_CONFIG_FILE (default: config/securd-market-risk-mainnet.json)
 * Flags: --print-calldata   encode and print calldata only, send nothing
 */
import { ethers } from "hardhat";
import fs from "fs";

interface IrmCurve {
  baseRatePerYear: string;
  multiplierPerYear: string;
  jumpMultiplierPerYear: string;
  kink: string;
}

interface MarketRiskEntry {
  cTokenSymbol: string;
  reserveFactorMantissa: string;
  irm: IrmCurve;
}

interface MarketRiskConfig {
  markets: MarketRiskEntry[];
}

interface DeploymentRecord {
  markets: Array<{ cToken: string; cTokenSymbol: string }>;
}

const CTOKEN_ABI = [
  "function admin() view returns (address)",
  "function interestRateModel() view returns (address)",
  "function reserveFactorMantissa() view returns (uint256)",
  "function _setInterestRateModel(address newInterestRateModel) returns (uint256)",
  "function _setReserveFactor(uint256 newReserveFactorMantissa) returns (uint256)",
];

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

async function main() {
  const printCalldataOnly = process.argv.includes("--print-calldata");

  const deploymentRecordPath = requiredEnv("DEPLOYMENT_RECORD_FILE");
  const riskConfigPath = optionalEnv("MARKET_RISK_CONFIG_FILE", "config/securd-market-risk-mainnet.json");

  const deployment: DeploymentRecord = JSON.parse(fs.readFileSync(deploymentRecordPath, "utf8"));
  const riskConfig: MarketRiskConfig = JSON.parse(fs.readFileSync(riskConfigPath, "utf8"));

  const iface = new ethers.Interface(CTOKEN_ABI);
  const JumpRateModel = printCalldataOnly ? undefined : await ethers.getContractFactory("JumpRateModelV2");

  let signer: Awaited<ReturnType<typeof ethers.getSigners>>[number] | undefined;
  if (!printCalldataOnly) {
    [signer] = await ethers.getSigners();
    console.log("Signer:", signer.address);
  }

  const calls: Array<{ symbol: string; to: string; fn: string; data: string }> = [];

  for (const entry of riskConfig.markets) {
    const market = deployment.markets.find((m) => m.cTokenSymbol === entry.cTokenSymbol);
    if (!market) {
      console.log(`Skipping ${entry.cTokenSymbol}: not present in ${deploymentRecordPath} (not deployed yet, e.g. Phase 2/3 market)`);
      continue;
    }

    console.log(`\n=== ${entry.cTokenSymbol} (${market.cToken}) ===`);
    console.log("  reserveFactorMantissa :", entry.reserveFactorMantissa);
    console.log("  IRM base/mult/jump/kink:", entry.irm.baseRatePerYear, entry.irm.multiplierPerYear, entry.irm.jumpMultiplierPerYear, entry.irm.kink);

    if (printCalldataOnly) {
      // Print calldata for a pre-deployed or to-be-deployed IRM plus the reserve-factor call.
      // The IRM address itself must be deployed separately when using multisig submission --
      // this mode only encodes the calls that require admin authorization.
      const reserveFactorData = iface.encodeFunctionData("_setReserveFactor", [entry.reserveFactorMantissa]);
      calls.push({ symbol: entry.cTokenSymbol, to: market.cToken, fn: "_setReserveFactor", data: reserveFactorData });
      console.log("  _setReserveFactor calldata:", reserveFactorData);
      console.log("  _setInterestRateModel calldata: (deploy the JumpRateModelV2 first, then encode manually --");
      console.log("    constructor args:", entry.irm.baseRatePerYear, entry.irm.multiplierPerYear, entry.irm.jumpMultiplierPerYear, entry.irm.kink, "<owner>)");
      continue;
    }

    const cToken = new ethers.Contract(market.cToken, CTOKEN_ABI, signer);
    const admin: string = await cToken.admin();
    if (admin.toLowerCase() !== signer!.address.toLowerCase()) {
      throw new Error(
        `Signer (${signer!.address}) is not admin on ${entry.cTokenSymbol} (admin=${admin}). ` +
        `Re-run with --print-calldata and submit through your multisig instead.`
      );
    }

    const irm = await JumpRateModel!.deploy(
      entry.irm.baseRatePerYear,
      entry.irm.multiplierPerYear,
      entry.irm.jumpMultiplierPerYear,
      entry.irm.kink,
      signer!.address
    );
    await irm.waitForDeployment();
    const irmAddr = await irm.getAddress();
    console.log("  Deployed IRM:", irmAddr);

    // XRPL EVM's Cosmos-based gas estimation is unreliable for calls that route through
    // accrueInterest()'s underlying.balanceOf() on the native-XRP precompile: confirmed live
    // that a 50%-padded estimate (63306 -> 94959) still reverted out-of-gas with gasUsed sitting
    // right at ~99% of whatever limit was supplied each time -- not a modest underestimate, the
    // estimator itself doesn't reflect real cost here. A fixed 500,000 gas limit (cheap at this
    // chain's sub-gwei gas price) succeeded with gasUsed=250000; use a generous fixed floor
    // instead of trusting eth_estimateGas for this specific call shape.
    async function withGasBuffer(method: string, args: unknown[]) {
      return (cToken[method] as any)(...args, { gasLimit: 500000n });
    }

    const tx1 = await withGasBuffer("_setInterestRateModel", [irmAddr]);
    const r1 = await tx1.wait();
    console.log("  _setInterestRateModel tx:", r1.hash);

    const tx2 = await withGasBuffer("_setReserveFactor", [entry.reserveFactorMantissa]);
    const r2 = await tx2.wait();
    console.log("  _setReserveFactor tx:", r2.hash);

    const [newIrm, newReserveFactor] = await Promise.all([
      cToken.interestRateModel(),
      cToken.reserveFactorMantissa(),
    ]);
    if (newIrm.toLowerCase() !== irmAddr.toLowerCase()) {
      throw new Error(`IRM assignment did not take effect for ${entry.cTokenSymbol}`);
    }
    if (newReserveFactor.toString() !== entry.reserveFactorMantissa) {
      throw new Error(`Reserve factor did not take effect for ${entry.cTokenSymbol}`);
    }
    console.log(`  Confirmed -- IRM ${newIrm}, reserveFactorMantissa ${newReserveFactor.toString()}`);
  }

  if (printCalldataOnly) {
    console.log("\n=== Calldata summary (submit via your multisig) ===");
    console.log(JSON.stringify(calls, null, 2));
  } else {
    console.log("\nDone.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
