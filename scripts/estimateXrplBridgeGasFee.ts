/**
 * Estimates the real Axelar relay fee (in XRP drops) for an XRPL Ledger -> XRPL EVM
 * bridge message, so callers of submitXrplDeposit.ts / submitXrplBorrow.ts / etc. can set
 * XRPL_*_GAS_FEE_DROPS to a properly-computed value instead of guessing.
 *
 * Why this exists: on 2026-09-17, a real mainnet SUPPLY deposit sent with
 * gas_fee_amount=0 (per this repo's own docs, which claimed that's correct for native
 * XRP) got stuck on Axelar with is_insufficient_fee=true. It was unstuck with an ad hoc
 * 800,000-drop ("0.8 XRP") Add Gas top-up -- a guess made under uncertainty, with no way
 * to know at the time how much of that was actually necessary.
 *
 * Investigating afterward: Axelar's own axelarjs-sdk (@axelar-network/axelarjs-sdk,
 * AxelarQueryAPI.estimateMultihopFee) computes exactly this, calling a single public
 * REST endpoint under the hood: POST https://api.axelarscan.io/gmp/estimateGasFeeForNHops.
 * For our xrpl -> axelar -> xrpl-evm route, that endpoint returned totalFee = "8560"
 * (drops, ~0.00856 XRP, ~$0.011) -- roughly 1% of what was actually paid. The SDK package
 * itself was NOT added as a dependency here: `npm install` reported 24 vulnerabilities
 * (1 critical, 5 high) from its bundled transitive deps, all avoidable since the fee
 * computation is one plain HTTP call with no signing/wallet logic of its own.
 *
 * This script calls that same endpoint directly with zero new dependencies, and applies
 * an explicit safety multiplier on top (default 3x) as a hedge against the estimate not
 * perfectly matching whatever threshold the live relayer network actually enforces --
 * that gap is real (see above) and unmeasured, so don't trust the raw estimate blindly,
 * but there's no reason to pay 100x over it either.
 *
 * Usage:
 *   npx ts-node scripts/estimateXrplBridgeGasFee.ts [destinationGasLimit] [safetyMultiplier]
 *
 * Defaults: destinationGasLimit=700000 (padded for XRPL EVM's own gas-estimation quirk
 * around calls that touch accrueInterest()'s underlying.balanceOf() on the native-XRP
 * precompile -- see docs/xrpl-evm-mainnet-deployment.md section 6), safetyMultiplier=3.
 */

const AXELARSCAN_API = "https://api.axelarscan.io";

interface HopParam {
  sourceChain: string;
  destinationChain: string;
  gasLimit: string;
}

interface EstimateResponse {
  totalFee: string;
  baseFee: string;
  executionFee: string;
  executionFeeWithMultiplier: string;
  details?: Array<{ totalFee: string; gasLimit: string; baseFee: string; executionFeeWithMultiplier: string }>;
}

async function estimateGasFeeForNHops(hops: HopParam[]): Promise<EstimateResponse> {
  const res = await fetch(`${AXELARSCAN_API}/gmp/estimateGasFeeForNHops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ params: hops, showDetailedFees: true }),
  });
  if (!res.ok) {
    throw new Error(`estimateGasFeeForNHops failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as EstimateResponse;
}

async function main() {
  const destinationGasLimit = process.argv[2] || "700000";
  const safetyMultiplier = Number(process.argv[3] || "3");

  const hops: HopParam[] = [
    { sourceChain: "xrpl", destinationChain: "axelar", gasLimit: "0" },
    { sourceChain: "axelar", destinationChain: "xrpl-evm", gasLimit: destinationGasLimit },
  ];

  const result = await estimateGasFeeForNHops(hops);
  const rawTotalDrops = BigInt(result.totalFee);
  const recommendedDrops = rawTotalDrops * BigInt(Math.round(safetyMultiplier * 100)) / 100n;

  const perHopSummary = (result.details || []).map((d) => ({
    totalFee: d.totalFee,
    gasLimit: d.gasLimit,
    baseFee: d.baseFee,
    executionFeeWithMultiplier: d.executionFeeWithMultiplier,
  }));

  console.log(JSON.stringify({
    route: "xrpl -> axelar -> xrpl-evm",
    destinationGasLimit,
    rawEstimateDrops: rawTotalDrops.toString(),
    rawEstimateXRP: (Number(rawTotalDrops) / 1e6).toFixed(6),
    safetyMultiplier,
    recommendedDrops: recommendedDrops.toString(),
    recommendedXRP: (Number(recommendedDrops) / 1e6).toFixed(6),
    perHopSummary,
  }, null, 2));

  console.log(`\nUse XRPL_*_GAS_FEE_DROPS=${recommendedDrops.toString()} as a starting point.`);
  console.log("This is a computed estimate, not a guaranteed minimum -- the live relayer");
  console.log("network's actual acceptance threshold hasn't been independently measured");
  console.log("against this endpoint's numbers. If a message still gets flagged");
  console.log("is_insufficient_fee=true, use the Add Gas top-up flow rather than resending.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
