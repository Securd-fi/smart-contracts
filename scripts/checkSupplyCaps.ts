/**
 * Read-only supply-cap monitor.
 *
 * Why this script exists: this Comptroller has no on-chain supply-cap mechanism at all
 * (verified: only borrowCaps exist in ComptrollerStorage.sol / Comptroller.sol --
 * _setMarketBorrowCaps is the only cap setter in the contract). The risk doc
 * (docs/securd-asset-listing-risk-parameters.md) lists a Supply Cap as a primary risk
 * control for every market. Since the contracts cannot enforce it, this script is the
 * operational substitute: run it periodically (cron / keeper infra) and alert or pause
 * the affected market manually when a cap is at or over its documented target.
 *
 * Underlying-denominated markets (XRP, USDC, mXRP, WETH, USDT, WBTC): total supplied =
 * getCash() + totalBorrows() - totalReserves(), in the underlying's own raw units,
 * compared directly against offChainSupplyCaps[symbol].amount (same unit).
 *
 * LP markets (sXRPUSDCLP, sXRPARMYLP): capped in USD in the doc, not in raw LP-token
 * units (LP token price moves) -- this script reports raw LP balance only and flags
 * that a USD conversion requires the live oracle price, left as a TODO wiring point
 * (SecurdPriceOracle.getUnderlyingPrice(cToken) once the oracle is deployed and
 * configured) rather than guessing a conversion here.
 *
 * Required env vars: XRPL_EVM_RPC_URL, DEPLOYMENT_RECORD_FILE
 * Optional env vars: MARKET_RISK_CONFIG_FILE (default: config/securd-market-risk-mainnet.json)
 */
import { ethers } from "hardhat";
import fs from "fs";

interface DeploymentRecord {
  oracle: string;
  markets: Array<{ cToken: string; cTokenSymbol: string; underlying: string }>;
}

interface OffChainSupplyCap {
  unit: string;
  amount: string;
}

interface MarketRiskConfig {
  offChainSupplyCaps: Record<string, OffChainSupplyCap>;
}

const CTOKEN_ABI = [
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalReserves() view returns (uint256)",
];

const ERC20_ABI = ["function decimals() view returns (uint8)"];

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
  const deploymentRecordPath = requiredEnv("DEPLOYMENT_RECORD_FILE");
  const riskConfigPath = optionalEnv("MARKET_RISK_CONFIG_FILE", "config/securd-market-risk-mainnet.json");

  const deployment: DeploymentRecord = JSON.parse(fs.readFileSync(deploymentRecordPath, "utf8"));
  const riskConfig: MarketRiskConfig = JSON.parse(fs.readFileSync(riskConfigPath, "utf8"));

  let anyOverCap = false;

  for (const market of deployment.markets) {
    const cap = riskConfig.offChainSupplyCaps[market.cTokenSymbol];
    if (!cap) {
      console.log(`${market.cTokenSymbol}: no offChainSupplyCaps entry, skipping`);
      continue;
    }

    const cToken = new ethers.Contract(market.cToken, CTOKEN_ABI, ethers.provider);
    const [cash, totalBorrows, totalReserves] = await Promise.all([
      cToken.getCash(),
      cToken.totalBorrows(),
      cToken.totalReserves(),
    ]);
    const totalSuppliedRaw = cash + totalBorrows - totalReserves;

    if (cap.unit === "USD") {
      console.log(
        `${market.cTokenSymbol}: totalSuppliedRaw=${totalSuppliedRaw.toString()} ` +
        `(LP token, raw units) -- target cap is $${cap.amount} USD. ` +
        `Compare manually against SecurdPriceOracle.getUnderlyingPrice(${market.cToken}) x totalSuppliedRaw ` +
        `until this script is wired to a live oracle read.`
      );
      continue;
    }

    const underlying = new ethers.Contract(market.underlying, ERC20_ABI, ethers.provider);
    let decimals = 18;
    try {
      decimals = await underlying.decimals();
    } catch {
      // decimals() call reverted for some reason (e.g. RPC hiccup) -- fall back to 18, which is
      // also what the native-XRP precompile at the 0xEeee... sentinel address itself reports
      // (verified live: it correctly implements decimals() and returns 18).
      decimals = 18;
    }

    const totalSuppliedHuman = Number(ethers.formatUnits(totalSuppliedRaw, decimals));
    const capHuman = Number(cap.amount);
    const pctOfCap = capHuman === 0 ? 0 : (totalSuppliedHuman / capHuman) * 100;
    const overCap = totalSuppliedHuman >= capHuman;
    if (overCap) anyOverCap = true;

    console.log(
      `${market.cTokenSymbol}: supplied=${totalSuppliedHuman.toFixed(6)} ${cap.unit} ` +
      `/ cap=${capHuman} ${cap.unit} (${pctOfCap.toFixed(1)}%)` +
      (overCap ? "  *** AT OR OVER CAP ***" : "")
    );
  }

  if (anyOverCap) {
    console.error("\nOne or more markets are at or over their documented supply-cap target.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
