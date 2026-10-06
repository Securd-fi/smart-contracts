/**
 * READ-ONLY dry run of the XRP/USDC LP price calculation, per docs/lp-price-calculation-spec.md.
 *
 * It reads the XRPL AMM pool and the oracle, computes the approved fair-formula price,
 * applies the guards that can be checked from a single read, and prints what the bot
 * WOULD do. It never posts, never signs, and needs no private key.
 *
 * Formula (approved 2026-10-06, see spec §2):
 *   A = R_x * P_x
 *   B = R_u * P_u
 *   F = 2 * sqrt(A * B) / L
 *   published = F * (1 - haircut)
 *
 * Guards checked here (spec §3):
 *   G1  inputs read and greater than 0
 *   G2  TVL >= minTvlUsd (test waiver, $25,000)
 *   G3  each side <= maxTokenWeightBps (85%)
 *   G6  step bounds vs the last on-chain posted price (+5% / -10%)
 *   G7  1% deviation trigger vs the last on-chain posted price
 *   G8  publisher XRP balance >= 0.05 XRP (only if XRPL_PUBLISHER_ADDRESS is set)
 *   G4, G5 need the 5-minute snapshot history, so a single dry run reports them as NOT EVALUATED.
 *
 * Env (all optional):
 *   XRPL_HTTP_RPC_URL          default https://s1.ripple.com (HTTP JSON-RPC, required for amm_info)
 *   XRPL_EVM_RPC_URL           default https://rpc.xrplevm.org
 *   LP_ORACLE_CONFIG           default config/xrpl-lp-oracle-test-xrp-usdc.json
 *   XRPL_PUBLISHER_ADDRESS     optional, the publisher's XRPL address, for the G8 check
 *
 * Run: npx ts-node scripts/computeXrplLpPriceDryRun.ts
 */
import path from "path";
import { ethers } from "ethers";
import { loadXrplLpOracleConfig } from "./xrplLpOracleConfig";

const ORACLE_ABI = [
  "function previewPrices(address asset) view returns (uint8 oracleType,uint256 chainlinkPriceMantissa,uint256 bandPriceMantissa,uint256 fallbackPriceMantissa,uint256 selectedPriceMantissa)",
  "function fallbackPriceOf(address asset) view returns (uint256 priceMantissa, uint256 updatedAt)"
];

const DEFAULT_ORACLE = "0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98";
const MIN_PUBLISHER_XRP_DROPS = 50_000n; // 0.05 XRP

type XrplAmount = string | { currency: string; issuer?: string; value: string };

function parseDecimalToE18(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  const normalizedFraction = `${fraction}000000000000000000`.slice(0, 18);
  return BigInt(whole || "0") * 10n ** 18n + BigInt(normalizedFraction || "0");
}

// XRP amounts from amm_info are drops (a string). IOU amounts are {value}. Both become 1e18 whole units.
function normalizeXrplAmount(amount: XrplAmount): bigint {
  if (typeof amount === "string") return BigInt(amount) * 10n ** 12n;
  return parseDecimalToE18(amount.value);
}

// Integer square root (floor) for BigInt, by Newton's method.
function bigSqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("sqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

function fmt(e18: bigint, decimals = 8): string {
  const scaled = e18 / 10n ** BigInt(18 - decimals);
  const whole = scaled / 10n ** BigInt(decimals);
  const frac = (scaled % 10n ** BigInt(decimals)).toString().padStart(decimals, "0");
  return `${whole}.${frac}`;
}

async function fetchAmmInfo(rpcUrl: string, pool: any): Promise<any> {
  const asset = (a: any) => (a.currency === "XRP" ? { currency: "XRP" } : a);
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "amm_info",
      params: [{ asset: asset(pool.xrpl.asset0), asset2: asset(pool.xrpl.asset1), ledger_index: "validated" }]
    })
  });
  if (!response.ok) throw new Error(`amm_info failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchXrpBalanceDrops(rpcUrl: string, account: string): Promise<bigint> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "account_info", params: [{ account, ledger_index: "validated" }] })
  });
  const body: any = await response.json();
  if (body.result?.error) throw new Error(`account_info: ${body.result.error}`);
  return BigInt(body.result.account_data.Balance);
}

async function main(): Promise<void> {
  const configPath = path.resolve(process.env.LP_ORACLE_CONFIG ?? "config/xrpl-lp-oracle-test-xrp-usdc.json");
  const config = loadXrplLpOracleConfig(configPath);
  const pool: any = config.pools[0];
  const haircutBps = BigInt(pool.risk.haircutBps);
  const minTvlUsdE18 = parseDecimalToE18(pool.risk.minTvlUsd);
  const maxWeightBps = BigInt(pool.risk.maxTokenWeightBps);
  const xrplHttp = process.env.XRPL_HTTP_RPC_URL ?? "https://s1.ripple.com";
  const evmRpc = process.env.XRPL_EVM_RPC_URL ?? "https://rpc.xrplevm.org";

  const provider = new ethers.JsonRpcProvider(evmRpc);
  const oracle = new ethers.Contract(process.env.ORACLE_ADDRESS ?? DEFAULT_ORACLE, ORACLE_ABI, provider);

  const failures: string[] = [];
  const notes: string[] = [];

  // --- Read the AMM pool (G1) ---
  const ammResponse = await fetchAmmInfo(xrplHttp, pool);
  if (!ammResponse.result?.validated || !ammResponse.result.amm) {
    throw new Error("AMM state is not validated. Stop.");
  }
  const amm = ammResponse.result.amm;
  const R_x = normalizeXrplAmount(amm.amount);
  const R_u = normalizeXrplAmount(amm.amount2);
  const L = normalizeXrplAmount(amm.lp_token);
  if (R_x === 0n || R_u === 0n || L === 0n) failures.push("G1: reserve or LP supply is zero");

  // --- Read the oracle flat prices (G1). Flat per whole token, 1e18. Not getUnderlyingPrice. ---
  const readFlat = async (asset: string): Promise<bigint> => {
    const [, , , , selected] = await oracle.previewPrices(asset);
    return BigInt(selected.toString());
  };
  const P_x = await readFlat(pool.evm.token0);
  const P_u = await readFlat(pool.evm.token1);
  if (P_x === 0n || P_u === 0n) failures.push("G1: an underlying price is missing (zero)");

  // --- Formula (spec §2) ---
  const E18 = 10n ** 18n;
  const A = (R_x * P_x) / E18; // USD value of the XRP side, 1e18
  const B = (R_u * P_u) / E18; // USD value of the USDC side, 1e18
  const V = A + B;
  let fairPublished = 0n;
  let sumPublished = 0n;
  if (L > 0n && V > 0n) {
    // F = 2 * sqrt(A * B) / L, returned at 1e18 scale.
    // A, B and L are all 1e18-scaled, so sqrt(A * B) is 1e18-scaled too.
    const sqrtAB = bigSqrt(A * B);
    const F = (2n * sqrtAB * E18) / L;
    const S = (V * E18) / L; // sum formula, for comparison only
    fairPublished = (F * (10_000n - haircutBps)) / 10_000n;
    sumPublished = (S * (10_000n - haircutBps)) / 10_000n;
  }

  // --- Guards from one read (spec §3) ---
  const weightXbps = V > 0n ? (A * 10_000n) / V : 0n;
  const weightUbps = V > 0n ? (B * 10_000n) / V : 0n;
  const tvlUsd = V;
  if (tvlUsd < minTvlUsdE18) failures.push(`G2: TVL $${fmt(tvlUsd, 2)} below $${pool.risk.minTvlUsd} floor`);
  if (weightXbps > maxWeightBps || weightUbps > maxWeightBps) {
    failures.push(`G3: a side is above ${Number(maxWeightBps) / 100}% (XRP ${Number(weightXbps) / 100}%, USDC ${Number(weightUbps) / 100}%)`);
  }

  // --- Last on-chain posted price (G6, G7) ---
  const [lastFallbackPrice, lastUpdatedAt] = await oracle.fallbackPriceOf(pool.evm.collateralAsset);
  const lastOnChain = BigInt(lastFallbackPrice.toString());
  let stepCheck = "no on-chain price yet: first post rules apply (G5, manual confirmation)";
  let triggerCheck = "no on-chain price yet: would post (first post)";
  if (lastOnChain > 0n) {
    const up = (lastOnChain * 10_500n) / 10_000n; // +5%
    const down = (lastOnChain * 9_000n) / 10_000n; // -10%
    if (fairPublished > up || fairPublished < down) {
      failures.push(`G6: ${fmt(fairPublished)} is outside the step bounds of the last on-chain price ${fmt(lastOnChain)} (-10% / +5%)`);
    }
    stepCheck = `G6 checked against last on-chain ${fmt(lastOnChain)} (last updated ${new Date(Number(lastUpdatedAt) * 1000).toISOString()})`;
    const diffBps = fairPublished > lastOnChain
      ? ((fairPublished - lastOnChain) * 10_000n) / lastOnChain
      : ((lastOnChain - fairPublished) * 10_000n) / lastOnChain;
    triggerCheck = diffBps >= 100n ? `G7: deviation ${Number(diffBps) / 100}% >= 1%, would post` : `G7: deviation ${Number(diffBps) / 100}% < 1%, would post only on the 120 s heartbeat`;
  }

  // --- Publisher XRP balance (G8), optional ---
  if (process.env.XRPL_PUBLISHER_ADDRESS) {
    const drops = await fetchXrpBalanceDrops(xrplHttp, process.env.XRPL_PUBLISHER_ADDRESS);
    if (drops < MIN_PUBLISHER_XRP_DROPS) failures.push(`G8: publisher holds ${Number(drops) / 1e6} XRP, below 0.05`);
    notes.push(`G8: publisher holds ${Number(drops) / 1e6} XRP`);
  } else {
    notes.push("G8: not checked (set XRPL_PUBLISHER_ADDRESS to check)");
  }

  notes.push("G4 (reserve jump vs 5-minute snapshot) and G5a/G5b (history and 1% agreement): NOT EVALUATED in a single read");
  notes.push("G5c (manual confirmation of the first post): operator action, not checked here");

  console.log(JSON.stringify({
    readOnly: true,
    pool: pool.name,
    inputs: {
      R_x_XRP: fmt(R_x), R_u_USDC: fmt(R_u), L_LP: fmt(L),
      P_x_USD: fmt(P_x), P_u_USD: fmt(P_u), haircut: `${Number(haircutBps) / 100}%`
    },
    intermediate: { A_USD: fmt(A), B_USD: fmt(B), V_USD: fmt(V), XRP_weight: `${Number(weightXbps) / 100}%`, USDC_weight: `${Number(weightUbps) / 100}%` },
    formula: {
      approved_fair_F_published: fmt(fairPublished),
      sum_S_published_for_comparison_only: fmt(sumPublished),
      gap_percent: fairPublished > 0n ? `${(Number(sumPublished - fairPublished) / Number(fairPublished) * 100).toFixed(4)}%` : "n/a"
    },
    lastOnChain: { price: fmt(lastOnChain), checks: [stepCheck, triggerCheck] },
    notes,
    decision: failures.length === 0 ? "WOULD POST (subject to the notes above)" : "WOULD NOT POST",
    failures
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
