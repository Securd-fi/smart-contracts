# Securd — Mainnet dApp Developer Guide

This is the mainnet counterpart to the integration work already documented for testnet
(see [xrpl-to-xrpl-evm-lending-guide.md](xrpl-to-xrpl-evm-lending-guide.md) and
[15-xrpl-lp-oracle-bot.md](15-xrpl-lp-oracle-bot.md)). Two things, as requested:

1. **How to build the on-chain price oracle for LP tokens** — full technical process.
2. **Mainnet contract addresses and real, executed example transactions** with their
   corresponding scripts, so you can wire the dApp against proven, working calls instead
   of guessing at conventions.

Everything below reflects the actual live mainnet deployment recorded in
[xrpl-evm-mainnet-deployment.md](xrpl-evm-mainnet-deployment.md) — addresses,
configuration values, and transaction hashes were re-verified directly against
`https://rpc.xrplevm.org` and XRPL Ledger mainnet while writing this, not copied from
earlier planning docs.

---

## Section 1 — Building the on-chain price oracle for LP tokens

### 1.1 Why LP tokens need a different pricing approach

Standard collateral (XRP, USDC) has a direct price feed — Securd uses Band's on-chain
reference (`SecurdPriceOracle`, `OracleType.BAND`) for both today. XRPL Ledger AMM LP
tokens have no such feed. Their fair value has to be *derived* from the AMM pool they
represent:

```
A = reserve0 × price0          (USD value of asset0 in the pool)
B = reserve1 × price1          (USD value of asset1 in the pool)
LP price (fair value) = 2 × sqrt(A × B) / total LP token supply
published price = LP price × (1 − haircut)
```

The fair value depends only on the pool's constant product, so it cannot be raised by moving the pool
out of balance. A simple sum, `(A + B) / supply`, can be, and is not used.

This is the same design already specified in
[15-xrpl-lp-oracle-bot.md](15-xrpl-lp-oracle-bot.md) — this section restates the
technical process with the actual mainnet pools substituted in, plus the exact on-chain
calls, so you don't have to cross-reference multiple docs to implement it.

### 1.2 The two mainnet LP pools you're pricing

Both queried live against XRPL Ledger mainnet (`amm_info`) while writing this doc:

**XRP/USDC pool**
- Pool (pseudo-)account: `rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE` — query with `amm_account`, no need to specify `asset`/`asset2` separately
- asset0 = XRP (native)
- asset1 = USDC, currency `5553444300000000000000000000000000000000`, issuer `rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE` (this is "Circle USDC" — see the important note in §2.4 about a *second*, different USDC token; for **pricing** purposes this is fine, since you just need a reliable USD reference, but never reuse this issuer for bridging)
- LP currency: `03B20F3A7D26D33C6DA3503E5CCE3E67B102D4D2`, issuer = the pool account itself
- Trading fee: 202 bps (2.02%)
- XRPL EVM wrapped LP token (the `underlying` you price): `0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53` (15 decimals), cToken `sXRPUSDCLP` = `0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F`

**XRP/ARMY pool**
- Pool (pseudo-)account: `rnsRq5ahgbFeRiAgBVvFTafyAgiS9x9Ztn`
- asset0 = XRP (native)
- asset1 = ARMY, currency `41524D5900000000000000000000000000000000`, issuer `rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC`
- LP currency: `037C2A57B0011520DE389E332043EC0FAF858ACE`, issuer = the pool account itself
- Trading fee: 0 bps
- XRPL EVM wrapped LP token: `0xD66b43e8a145e3b9e2d7e0F12f28255CB647Db7e` (15 decimals), cToken `sXRPARMYLP` = `0x48C2A0cA5a2780199ADd81BB7828612314Ae1728`

**Important asymmetry:** ARMY has no price feed on `SecurdPriceOracle` (it isn't, and
isn't planned to be, a listed Securd asset). Per the deliberate design decision already
recorded in `config/securd-markets-mainnet-phase1.json`'s comment for this market, **only
the XRP-side reserve is priced; the ARMY-side reserve is valued at 0.** This is
conservative (it can only under-value the LP token, never over-value it), but it means
the *generic* bot code path (§1.8) can't be used unmodified for this one pool — see
§1.8's note.

### 1.3 Reading the pool state — `amm_info`

```ts
const res = await xrplClient.request({
  command: "amm_info",
  amm_account: "rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE", // or rnsRq5ahgbFeRiAgBVvFTafyAgiS9x9Ztn
  ledger_index: "validated"
});
const { amount, amount2, lp_token, trading_fee } = res.result.amm;
```

`amount` is XRP, always a plain drops string. `amount2` and `lp_token` are issued-currency
objects (`{ currency, issuer, value }`). Normalize both to decimal numbers before pricing
— XRP: `Number(amount) / 1e6`; issued currencies: `Number(value)` directly (XRPL already
represents these as decimal strings, no further scaling).

Always pass `ledger_index: "validated"` — an unvalidated read is not a safe pricing input.

### 1.4 Reading the underlying asset prices — already live on mainnet

For the XRP/USDC pool, both sides already have a working oracle feed on the deployed
`SecurdPriceOracle` (`0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98`) — you don't need a
second price source, just read this contract:

```ts
const ORACLE_ABI = [
  "function previewPrices(address asset) view returns (uint8 oracleType, uint256 chainlinkPriceMantissa, uint256 bandPriceMantissa, uint256 fallbackPriceMantissa, uint256 selectedPriceMantissa)"
];
const oracle = new ethers.Contract("0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98", ORACLE_ABI, provider);
const [, , , , xrpPriceMantissa]  = await oracle.previewPrices("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"); // native XRP precompile
const [, , , , usdcPriceMantissa] = await oracle.previewPrices("0xa16148c6Ac9EDe0D82f0c52899e22a575284f131"); // sUSDC underlying
```

**Use `previewPrices`, not `getUnderlyingPrice`, for this.** `previewPrices` returns flat
1e18-precision USD values (the same convention Band/Chainlink report natively).
`getUnderlyingPrice` additionally applies Comptroller's `10^(18-underlyingDecimals)`
raw-balance scaling — correct for what Comptroller consumes internally, but it will
silently corrupt this pool-value computation if you use it here instead. This exact
mistake caused a real mispricing bug earlier in this project's history (see
[15-xrpl-lp-oracle-bot.md](15-xrpl-lp-oracle-bot.md) §18) — don't repeat it.

A `0` return means no valid price is currently available; treat that as "do not publish."

### 1.5 The valuation formula

```ts
function computePublishedPriceMantissa(
  reserve0E18: bigint,   // pool reserve of asset0, scaled to 1e18
  reserve1E18: bigint,   // pool reserve of asset1, scaled to 1e18
  price0E18: bigint,     // from previewPrices, already 1e18
  price1E18: bigint,
  lpSupplyE18: bigint,   // total LP token supply, scaled to 1e18
  haircutBps: number
): bigint {
  // A and B: USD value of each side, 1e18-scaled.
  const aE18 = mulDiv(reserve0E18, price0E18, 10n ** 18n);
  const bE18 = mulDiv(reserve1E18, price1E18, 10n ** 18n);
  // Fair value F = 2 * sqrt(A * B) / L, at 1e18 scale. A*B is 1e36-scaled, so isqrt(A*B) is 1e18-scaled.
  // isqrt: integer square root, floor. See bigSqrt in scripts/computeXrplLpPriceDryRun.ts.
  const fairRawE18 = mulDiv(2n * isqrt(aE18 * bE18), 10n ** 18n, lpSupplyE18);
  return mulDiv(fairRawE18, BigInt(10_000 - haircutBps), 10_000n);
}
```

This is `scripts/runXrplLpOracleBot.ts`'s actual `computePublishedPriceMantissa` —
already implemented and tested (`test/unit/xrplLpOracleBot.spec.ts`), not something you
need to write from scratch. The result is a flat `$-per-whole-LP-token` value at 1e18
precision, ready to post directly.

**Recommended haircut** (per §7 of the LP oracle bot doc): 5–10% for the XRP/USDC pool
(both sides oracle-backed, high liquidity); since XRP/ARMY prices the ARMY side at 0
already (an implicit ~50%+ haircut baked into the formula itself), an *additional*
haircut of 5–10% on top is still reasonable for AMM-reserve manipulation risk.

### 1.6 Posting the price on-chain

```solidity
function postFallbackPrice(address asset, uint256 priceMantissa) external onlyAssetOracle(asset);
```

Restricted to addresses explicitly authorized via `setAssetOracle(asset, oracle, true)`
(owner-only), or the contract owner directly. `asset` is the **underlying LP token
address** (`0xbAF2e0ef...`/`0xD66b43e8a...`), not the cToken.

**Current on-chain state (verified live, not assumed):** both LP markets already have
`oracleType = FALLBACK` (`3`) and `fallbackMaxDelay = 900` seconds configured — this was
done automatically at deploy time by `deploySecurdStack.ts` from
`config/securd-markets-mainnet-phase1.json`. **The only remaining on-chain step before
your bot can publish is authorizing its publisher wallet:**

```ts
// Must be signed by DEPLOY_OWNER (0x57eb9411CA49752994b81cd1B60c3917Cb99247C)
await oracle.setAssetOracle("0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53", BOT_WALLET_ADDRESS, true);
await oracle.setAssetOracle("0xD66b43e8a145e3b9e2d7e0F12f28255CB647Db7e", BOT_WALLET_ADDRESS, true);
```

Coordinate this with whoever holds `DEPLOY_OWNER` before going live — the bot's wallet
cannot post until this is done (it will revert with `NotAssetOracle`).

### 1.7 Safety checks before every publish

Reject and skip publishing (don't publish a degraded price) if any of:

- `amm_info` fails, or either reserve / LP supply is 0
- either underlying price read is 0 (§1.4)
- pool TVL is below your configured minimum (suggested: $50,000)
- one side exceeds ~95% of pool value (composition too concentrated)
- price moved more than your configured circuit-breaker threshold (suggested: 15%) since
  the last published value, without manual confirmation
- reserves jumped abnormally between polls (require re-confirmation across ledgers)

Full detail and rationale: [15-xrpl-lp-oracle-bot.md](15-xrpl-lp-oracle-bot.md) §8.

### 1.8 Running the bot

The bot already exists and is tested — you're configuring and operating it, not building
it from zero:

```bash
npx ts-node scripts/validateXrplLpOracleConfig.ts config/xrpl-lp-oracle-mainnet.json
npx ts-node scripts/runXrplLpOracleBot.ts config/xrpl-lp-oracle-mainnet.json
```

Call `ts-node` directly, not `npm run validate:lp-oracle-config`/`npm run bot:lp-oracle` —
those npm scripts have `config/xrpl-lp-oracle.example.json` hardcoded as the argument
inside `package.json` itself. `npm run validate:lp-oracle-config -- <path>` does **not**
override it; the script reads `process.argv[2]`, which npm has already filled with the
hardcoded example path, so your path just becomes an ignored extra argument and you'd
silently validate the wrong file.

Mainnet config (create `config/xrpl-lp-oracle-mainnet.json` from this shape):

```json
{
  "rpc": {
    "xrplRpcUrl": "wss://s2.ripple.com",
    "xrplEvmRpcUrl": "https://rpc.xrplevm.org"
  },
  "wallet": {
    "publisherPrivateKeyEnv": "LP_ORACLE_PRIVATE_KEY"
  },
  "defaults": {
    "pollIntervalMs": 15000,
    "publishIntervalSec": 120,
    "minDeviationBps": 100,
    "maxPriceAgeSec": 180,
    "maxReserveJumpBps": 1500,
    "maxStepUpBps": 500,
    "maxStepDownBps": 1000
  },
  "pools": [
    {
      "name": "XRP-USDC-mainnet",
      "xrpl": {
        "asset0": { "currency": "XRP" },
        "asset1": {
          "currency": "5553444300000000000000000000000000000000",
          "issuer": "rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE"
        }
      },
      "evm": {
        "collateralAsset": "0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53",
        "token0": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        "token1": "0xa16148c6Ac9EDe0D82f0c52899e22a575284f131"
      },
      "risk": {
        "haircutBps": 800,
        "minTvlUsd": "500000",
        "maxTokenWeightBps": 8500
      }
    }
  ]
}
```

**On `minTvlUsd`:** §1.7's `$50,000` is the general absolute floor
([15-xrpl-lp-oracle-bot.md](15-xrpl-lp-oracle-bot.md) §8.3). The `$500,000` used here is
a tighter, pool-specific threshold — the XRP/USDC pool's live reserves were ~234,843 XRP
+ ~305,637 USDC at the time this doc was written (verified via `amm_info`), roughly
**$610k–$615k** at current prices, so `$500,000` acts as a "stop publishing if this
specific large pool suddenly drains by more than ~20%" guard rather than the bare
minimum floor. Set it relative to each pool's own normal size, not copied blindly.

**XRP/ARMY is deliberately omitted from this example.** The schema's `token0`/`token1`
fields are both mandatory addresses that must resolve to a non-zero `previewPrices`
result — the generic bot has no "value this side at 0" mode. Since ARMY has no
`SecurdPriceOracle` feed by design, wiring this pool requires either (a) a small,
explicit fork of `computePublishedPriceMantissa` for this one pool that hardcodes
`price1E18 = 0n`, or (b) extending the config schema with an opt-in "zero-price side"
flag. Don't try to satisfy the existing schema by pointing `token1` at an unrelated
address with a real price — that would silently value ARMY at the wrong asset's price,
which is worse than the current conservative "value at 0" design. Flag this to whoever
owns the oracle bot rollout before enabling XRP/ARMY as live collateral.

### 1.9 Decentralization path (for when volume justifies it)

Launch state, matches what's live today: **single publisher key, strong on-chain
controls** (owner-gated authorization, strict `fallbackMaxDelay`, conservative haircut).
`SecurdMedianOracleReporter.sol` exists in the codebase for a later phase (multiple
independent reporters, on-chain median aggregation) but **was not deployed at mainnet
launch** (`SECURD_DEPLOY_MEDIAN_ORACLE_REPORTER=false` in the deployment config) — deploy
it separately via `npm run deploy:median-oracle-reporter` when ready to decentralize
beyond one key. Full phased plan: [15-xrpl-lp-oracle-bot.md](15-xrpl-lp-oracle-bot.md)
§20–21.

**A published price alone does not make these markets usable as collateral.** Both LP
markets currently read a **0% collateral factor on-chain** due to a separate, unrelated
deploy-time bug — see §2.2. Getting the oracle live is a prerequisite for fixing that
(the original `_setCollateralFactor` call silently no-op'd specifically because the LP
price was 0 at the time), but the collateral factor itself needs its own follow-up
transaction through the 48h `CollateralFactorTimelock` once a real price is flowing.

---

## Section 2 — Mainnet contract addresses and example transactions

### 2.1 Core Securd contracts (XRPL EVM mainnet, chain ID `1440000`)

| Contract | Address |
|---|---|
| Unitroller (Comptroller proxy — call this for all Comptroller reads) | `0xf2631D04bf1E568c777e822213040785B968405E` |
| SecurdPriceOracle | `0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98` |
| XRPLSecurdBridgeAdapter | `0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848` |
| XRPLUserProxyFactory | `0x06B219Afe66EB4A2508D1c0F1ab4102d5cF776fA` |
| CollateralFactorTimelock (Unitroller admin) | `0xEB27E14a7E7Dd1652FBC6220df56F28a6b1047Fb` |
| SecurdLiquidationKeeper | `0xB46013E32E4010E62e7FCF88f083191d6D8A226f` |

### 2.2 Markets (Phase 1)

| Symbol | cToken | Underlying | CF | Oracle |
|---|---|---|---|---|
| sXRP | `0xEFedd95eFdB71652bd93F58b2B7F77748Dee04F6` | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` | 75% | BAND |
| sUSDC | `0x21Da09A16d69757C0731De3b83e65061BCF30E00` | `0xa16148c6Ac9EDe0D82f0c52899e22a575284f131` | 80% | BAND |
| smXRP | `0xAf0be979e1B842B4C53Ed10fE81991D92be5B32E` | `0x06e0B0F1A644Bb9881f675Ef266CeC15a63a3d47` | 60% | FALLBACK (price currently stale — do not surface as usable collateral in the dApp yet) |
| sXRPUSDCLP | `0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F` | `0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53` | 0%* | FALLBACK (see §1) |
| sXRPARMYLP | `0x48C2A0cA5a2780199ADd81BB7828612314Ae1728` | `0xD66b43e8a145e3b9e2d7e0F12f28255CB647Db7e` | 0%* | FALLBACK (see §1) |

\* Configured CF is 57%/35% but currently reads 0% on-chain due to a deploy-time bug
(`_setCollateralFactor` silently no-op'd while LP price was still 0) — not yet fixed.
Don't let the dApp present these as usable collateral until this is corrected.

### 2.3 Axelar infrastructure (mainnet)

| Role | Value |
|---|---|
| XRPL Ledger gateway account | `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` |
| Axelar source/destination chain name for XRPL Ledger | `xrpl` |
| Axelar destination chain name for XRPL EVM | `xrpl-evm` |
| InterchainTokenService (XRPL EVM) | `0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C` |
| AxelarGateway (XRPL EVM) | `0xe432150cce91c13a887f7D836923d5597adD8E31` |
| XRPL Ledger RPC | `wss://s1.ripple.com` or `wss://s2.ripple.com` |
| XRPL EVM RPC | `https://rpc.xrplevm.org` |

### 2.4 The USDC gotcha — read this before wiring any USDC flow

**Two different "USDC" tokens exist on XRPL Ledger mainnet.** Only one of them bridges
to Securd's real `sUSDC` market. Using the wrong one is a silent, unrecoverable mistake
— it happened once during our own testing and the funds are still stuck.

| | Circle USDC — **do not use for bridging** | USDC.axl — **correct for Securd** |
|---|---|---|
| Currency | `5553444300000000000000000000000000000000` | `555344432E61786C000000000000000000000000` |
| Issuer | `rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE` | `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` (the Axelar gateway itself) |
| Bridges to | `0xDaF4556169c4F3f2231d8ab7BC8772Ddb7D4c84C` (15 decimals — **not** sUSDC) | `0xa16148c6Ac9EDe0D82f0c52899e22a575284f131` (6 decimals — real sUSDC) |

Any dApp flow that sends USDC into Securd (supply, repay) must use **USDC.axl**, issuer
`rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`. The user needs an open trustline to that specific
issuer+currency before sending.

**Amount scaling for USDC.axl:** the ITS-delivered EVM amount matches the real
underlying's decimals (6) — `envelope.amount = ethers.parseUnits(value, 6)`. Confirmed
empirically from a real mainnet transaction, not assumed (see
[xrpl-evm-mainnet-deployment.md](xrpl-evm-mainnet-deployment.md) §5.4d).

### 2.5 Example executed transactions, with their scripts

Every transaction below actually ran on mainnet and was independently verified on-chain
(not just via Axelar's relay status). Full narrative and root-cause notes:
[xrpl-evm-mainnet-deployment.md](xrpl-evm-mainnet-deployment.md) §5.

**Gateway default trap — check this on every script before running it.**
`submitXrplDeposit.ts`, `submitXrplWithdraw.ts`, `submitXrplEnterMarket.ts`, and
`submitXrplExitMarket.ts` are pre-existing scripts whose `XRPL_AXELAR_GATEWAY`
**defaults to the testnet gateway**
(`rNrjh1KGZk2jBR3wPfAQnoidtFFYQKbQn2`) if left unset — running them on mainnet without
explicitly passing `XRPL_AXELAR_GATEWAY=rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` sends the
payment to the wrong account and the funds will not bridge. The three mainnet-authored
scripts (`submitXrplUsdcSupply.ts`, `submitXrplUsdcBorrow.ts`, `submitXrplUsdcRepay.ts`)
default correctly to the mainnet gateway already, but setting it explicitly everywhere
is the safer habit — that's what every command below does.

**Supply XRP collateral** — `scripts/submitXrplDeposit.ts`
XRPL tx: https://livenet.xrpl.org/transactions/E283923D44C0E4DB8DD019EAEEE1F69A075A54A919BE0CE51917EFA82B7215BB
```bash
XRPL_SEED=<user seed> \
XRPL_RPC_URL=wss://s2.ripple.com \
XRPL_AXELAR_GATEWAY=rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw \
XRPL_EVM_AXELAR_CHAIN=xrpl-evm \
XRPL_EVM_RPC_URL=https://rpc.xrplevm.org \
XRPL_BRIDGE_ADAPTER=0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848 \
XRPL_DEPOSIT_MARKET=0xEFedd95eFdB71652bd93F58b2B7F77748Dee04F6 \
XRPL_DEPOSIT_UNDERLYING=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE \
XRPL_DEPOSIT_DESTINATION_ADDRESS=0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848 \
XRPL_DEPOSIT_AMOUNT_DROPS=1000000 \
INTENT_SIGNER_PRIVATE_KEY=<registered intent signer key> \
XRPL_CONFIRM_SEND=true \
npx ts-node scripts/submitXrplDeposit.ts
```

**Partial withdraw** — `scripts/submitXrplWithdraw.ts`
XRPL tx: https://livenet.xrpl.org/transactions/E0E2FB00F0FECEEC02A5E772F0B58CAF169B25A447C14F11661191F36BEA5735
Uses `XRPL_WITHDRAW_AMOUNT_XRP` (human-readable XRP string, e.g. `"0.3"`, internally
converted via `parseEther`) and `XRPL_GMP_GAS_DROPS` for the relay fee (size it with
§2.6's estimator — default `3000000` is a large overpay, don't rely on it).

**Supply USDC liquidity** — `scripts/submitXrplUsdcSupply.ts` (mainnet-corrected script;
do not use `submitXrplDeposit.ts` for USDC, it assumes native XRP's drops→wei scaling)
XRPL tx: https://livenet.xrpl.org/transactions/3CECC2F06B878D496B6E9ED4131F50EAB55386FC5B6E40B10E56A09332C3217F
```bash
XRPL_SEED=<user seed> \
XRPL_RPC_URL=wss://s2.ripple.com \
XRPL_AXELAR_GATEWAY=rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw \
XRPL_EVM_AXELAR_CHAIN=xrpl-evm \
XRPL_EVM_RPC_URL=https://rpc.xrplevm.org \
INTENT_SIGNER_PRIVATE_KEY=<registered intent signer key> \
XRPL_BRIDGE_ADAPTER=0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848 \
XRPL_USDC_MARKET=0x21Da09A16d69757C0731De3b83e65061BCF30E00 \
XRPL_USDC_UNDERLYING=0xa16148c6Ac9EDe0D82f0c52899e22a575284f131 \
XRPL_USDC_SUPPLY_AMOUNT=0.03 \
XRPL_CONFIRM_SEND=true \
npx ts-node scripts/submitXrplUsdcSupply.ts
```

**Enter market (activate collateral)** — `scripts/submitXrplEnterMarket.ts`
XRPL tx: https://livenet.xrpl.org/transactions/CE1C45919738ABBD31C743A2B19F0DC616D55927D053540DEE537D28855071A9

**Borrow USDC** — `scripts/submitXrplUsdcBorrow.ts` (mainnet-corrected; do not use
`submitXrplBorrow.ts` for USDC, it hardcodes 18-decimal scaling)
XRPL tx: https://livenet.xrpl.org/transactions/3049AA44F75B08EAF5E187C988AFCF34B5D7AE85F44FC76A862CFE1552722298

**Repay USDC** — `scripts/submitXrplUsdcRepay.ts` (mainnet-corrected, same reasoning)
XRPL tx: https://livenet.xrpl.org/transactions/D68591A7C66BE503EE1182C310D91D819CC8945F7A82FD29061B57AE888A8B30

For every intent above, the corresponding cross-chain relay can be inspected at
`https://axelarscan.io/gmp/<xrpl tx hash, lowercase>`.

### 2.6 Estimating the relay gas fee — don't guess

```bash
npx ts-node scripts/estimateXrplBridgeGasFee.ts 500000 3
```

Calls Axelar's own `estimateGasFeeForNHops` endpoint directly (zero new dependencies)
and applies a 3x safety multiplier. **Where the estimate goes depends on the action
type:**
- ITS actions (SUPPLY, REPAY — `submitXrplUsdcSupply.ts`/`submitXrplUsdcRepay.ts`): the
  `gas_fee_amount` memo field, a separate amount on top of the value being transferred
  (`XRPL_USDC_GAS_FEE`, in the same IOU's units, or `0` if you intend to top up
  separately with Add Gas — see §5.4d/§5.5 of the deployment doc for both patterns
  working).
- GMP actions (ENTER_MARKET, EXIT_MARKET, BORROW, WITHDRAW —
  `submitXrplEnterMarket.ts`/`submitXrplExitMarket.ts`/`submitXrplUsdcBorrow.ts`/
  `submitXrplWithdraw.ts`): there is no separate gas field — the **entire native-XRP
  `Amount` of the Payment itself is the gas** (`XRPL_GMP_GAS_DROPS`).

If a message still comes back `is_insufficient_fee: true` on Axelarscan, top it up with
`scripts/sendXrplAddGasTopup.ts` rather than resubmitting — **signed intent envelopes are
immutable once sent**; a wrong/insufficient message cannot be corrected, only topped up
(for fee) or abandoned (for a wrong amount/token, which is unrecoverable — see §2.4).

### 2.7 Known gotchas to build around

- **XRPL EVM `eth_estimateGas` is unreliable** for any call touching
  `accrueInterest()`'s native-XRP-precompile `balanceOf()`. Use a fixed gas limit
  (500,000 worked reliably; ~250,000 actually consumed) rather than trusting the
  estimate.
- **The bridge adapter needs its own native XRP balance** to pay for egress
  (`WITHDRAW`/`BORROW` deliver tokens back to XRPL Ledger via `interchainTransfer{value:
  egressGasValue}`). If a borrow/withdraw call reverts with an apparent funding issue,
  check the adapter's own XRP balance against `egressGasValue()` before assuming a
  user-side problem.
- **Repay amount must not exceed the actual outstanding debt** unless using the
  `repayAll` sentinel (`amount = type(uint256).max`) — Compound's
  `accountBorrowsPrev - actualRepayAmount` underflows and reverts on overpayment. Don't
  round up "for safety" without also switching to the sentinel.
- **The intent-signer key env var name is inconsistent across scripts** — check before
  running: `submitXrplUsdcBorrow.ts`, `submitXrplEnterMarket.ts`, and
  `submitXrplExitMarket.ts` require `DEPLOYER_PRIVATE_KEY` (despite the value being the
  registered intent-signer key, not the protocol deployer's key — confusing but that's
  what the code checks for); `submitXrplUsdcSupply.ts` and `submitXrplUsdcRepay.ts`
  require `INTENT_SIGNER_PRIVATE_KEY`; `submitXrplWithdraw.ts` accepts either, falling
  back to `DEPLOYER_PRIVATE_KEY` if `INTENT_SIGNER_PRIVATE_KEY` is unset. Passing the
  right key under the wrong variable name fails with a generic "missing required env var"
  error, not a signature error, so it's easy to misdiagnose.
