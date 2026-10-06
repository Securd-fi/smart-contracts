# LP Token Price Updates — How to Post Real Prices On-Chain

Written for the dApp developer: how to actually get real prices flowing into `SecurdPriceOracle` for the two
LP markets (`sXRPUSDCLP`, `sXRPARMYLP`), using your own key with a narrow, purpose-built authorization —
not the protocol owner key. Companion to
[15-xrpl-lp-oracle-bot.md](15-xrpl-lp-oracle-bot.md) (the canonical design doc — read that first for the full
rationale) and [xrpl-evm-mainnet-dapp-developer-guide.md](xrpl-evm-mainnet-dapp-developer-guide.md) §1 (a
condensed version of the same material).

## 0. Key handling — read this before anything else

**Who can post these prices right now:** nobody but the protocol owner. Checked live, fresh, as of writing
this doc — `isAssetOracle(asset, address)` on `SecurdPriceOracle` returns `false` for every address except
the owner, for both LP underlyings. There is no dedicated "LP oracle bot" address yet. The only address that
can currently call `postFallbackPrice` for either LP market is:

```
0x57eb9411CA49752994b81cd1B60c3917Cb99247C   (protocol owner — do not use this for routine price posting)
```

That address should **not** become the one that runs the bot day-to-day — it's the same key that controls
pausing, fund withdrawal, and market listing across the whole protocol. The point of this document is to set
up a *new*, narrow-purpose address instead, with no power beyond posting a price for these two specific
assets. Until the steps below are done, nobody but the owner can post anything.

**No private key is provided in this document, and none should ever be committed to a repo or pasted into a
chat.** The mechanism here is authorization, not key-sharing:

1. **You generate your own key** for this, on your own machine, however you normally generate keys for
   services you run (a fresh EOA — never reuse an existing one, never reuse the protocol owner's key).
2. **You send only the public address** to Mohamed (not the private key — he never needs it and should
   never have it).
3. **Mohamed, using the protocol owner key, authorizes that address** on-chain via `setAssetOracle` (§3
   below) — a single call per LP underlying. This is the *only* thing that address can then do: post a
   fallback price for those two specific assets. It cannot pause the protocol, touch funds, change markets,
   or do anything else — confirmed directly from the contract's access-control modifier (§2).
4. If that key is ever compromised, the fix is one call: `setAssetOracle(asset, thatAddress, false)` —
   revoked, no other exposure, no redeploy.

This mirrors exactly the registrar-gate pattern already in place for user onboarding: a narrow, dedicated,
revocable capability instead of broad admin access.

## 1. What "posting a price" actually requires — the formula

LP tokens have no independent price feed. The entire input is: the XRPL AMM pool's live reserves, and the
already-live Band prices for the two underlying assets (XRP is already priced; USDC is already priced on
this protocol's oracle). The approved formula is the fair value (see [lp-price-calculation-spec.md](lp-price-calculation-spec.md) §2):

```
aE18           = reserve0E18 * price0E18 / 1e18
bE18           = reserve1E18 * price1E18 / 1e18
fairRawE18     = 2 * sqrt(aE18 * bE18) * 1e18 / lpSupplyE18
publishedPrice = fairRawE18 * (10000 - haircutBps) / 10000
```

Note: `scripts/runXrplLpOracleBot.ts` in the repo still computes the older sum-based value
(`poolValue / lpSupply`). That formula is not the approved one. Switching the bot to the fair formula is
part of the change pending the owner's written approval and PR #2 in `docs/15`.

`price0E18`/`price1E18` come from `SecurdPriceOracle.previewPrices(address)` — **not** `getUnderlyingPrice`,
which applies a different, Comptroller-specific scaling that would corrupt this math (this exact mistake is
flagged explicitly in the bot's own source comments; see §18 of the design doc).

## 2. The two LP markets, live state (verified directly, not assumed)

| | XRP/USDC LP | XRP/ARMY LP |
|---|---|---|
| cToken | `0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F` | `0x48C2A0cA5a2780199ADd81BB7828612314Ae1728` |
| **Underlying (this is the `asset` argument everywhere below)** | `0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53` | `0xD66b43e8a145e3b9e2d7e0F12f28255CB647Db7e` |
| XRPL AMM pool account | `rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE` | `rnsRq5ahgbFeRiAgBVvFTafyAgiS9x9Ztn` |
| Live reserves (checked just now) | 10,317.797 XRP / 15,516.02 USDC | 236,444.17 XRP / 42,682,296.99 ARMY |
| Live LP supply | 11,560,011.33 | 3,157,193,841.21 |
| Trading fee | 202 bps | 0 bps |
| `oracleType` on-chain | `3` (FALLBACK) — already set | `3` (FALLBACK) — already set |
| `fallbackMaxDelay` on-chain | `900` seconds — already set | `900` seconds — already set |
| Current posted price | **0 / never posted** (`fallbackPriceOf` returns `priceMantissa: 0, updatedAt: 0`) | same, **0 / never posted** |
| `isAssetOracle[asset][anyone]` | `false` for every address today | `false` for every address today |

**What this means:** the only remaining on-chain step before you can post anything is the `setAssetOracle`
authorization in §3. `oracleType` and `fallbackMaxDelay` are already correctly configured — don't touch
those.

**Important asymmetry — ARMY has no price feed, by design.** Per the already-documented, deliberate
decision (`config/securd-markets-mainnet-phase1.json`'s comment for this market), only the XRP-side reserve
of the XRP/ARMY pool is priced; the ARMY-side reserve is valued at `0`. This is conservative (can only
under-value the LP token) but means the generic bot's config schema (which requires both `token0` and
`token1` to resolve to a non-zero price) cannot be used unmodified for this one pool — see §5.

## 3. Authorization — the one call the owner needs to make

Once you send Mohamed your bot's public address (`BOT_ADDRESS`), he runs, from the protocol owner key:

```solidity
// SecurdPriceOracle at 0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98
setAssetOracle(0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53, BOT_ADDRESS, true)  // XRP/USDC LP
setAssetOracle(0xD66b43e8a145e3b9e2d7e0F12f28255CB647Db7e, BOT_ADDRESS, true)  // XRP/ARMY LP
```

Verify afterward (either of you, read-only, no key needed):

```bash
cast call 0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98 \
  "isAssetOracle(address,address)(bool)" 0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53 BOT_ADDRESS \
  --rpc-url https://rpc.xrplevm.org
```

Should return `true` for both assets before you run the bot for real.

**What `BOT_ADDRESS` can do after this:** call `postFallbackPrice(asset, priceMantissa)` for exactly these
two assets. Confirmed directly from the contract's modifier:

```solidity
modifier onlyAssetOracle(address asset) {
    if (!isAssetOracle[asset][msg.sender] && msg.sender != owner()) revert NotAssetOracle(asset, msg.sender);
    _;
}
```

Nothing else on this contract, or any other contract in the stack, checks `isAssetOracle` — this authorization
has no effect anywhere else.

## 4. Running the bot

The bot already exists, is tested (`test/unit/xrplLpOracleBot.spec.ts`), and needs no code changes for the
XRP/USDC pool:

```bash
npx ts-node scripts/validateXrplLpOracleConfig.ts config/xrpl-lp-oracle-mainnet.json
npx ts-node scripts/runXrplLpOracleBot.ts config/xrpl-lp-oracle-mainnet.json
```

(Call `ts-node` directly, not the `npm run` wrappers — those have the example config path hardcoded and
silently ignore an override.)

Config file to create, `config/xrpl-lp-oracle-mainnet.json` (XRP/USDC only — see §5 for ARMY):

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
        "minTvlUsd": "25000",
        "maxTokenWeightBps": 8500
      }
    }
  ]
}
```

`LP_ORACLE_PRIVATE_KEY` is set in **your own environment only** — this repo, this doc, and Mohamed never see
its value, only the config shape above.

**On `minTvlUsd`:** this pool's live TVL is ~$31K (10,317.8 XRP + 15,516.02 USDC at current prices) — set
below that, e.g. $25,000, as a "stop publishing if this pool drains significantly" guard, not the general
$50,000 floor used for a hypothetical larger pool (see [15-xrpl-lp-oracle-bot.md](15-xrpl-lp-oracle-bot.md)
§8.3 for the general floor).

**On the currency/issuer for the XRP/USDC pool's `asset1`:** this is the AMM pool's actual composition —
"Circle USDC" (`issuer rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE`), confirmed live via `amm_info` just now. This is
correct **here**, for pricing — do not confuse it with the separate finding elsewhere that bridging USDC into
the `sUSDC` *lending* market requires a different issuer (`USDC.axl`). Those are two unrelated concerns; this
doc is about reading AMM reserves, not bridging tokens.

## 5. XRP/ARMY — needs a small, explicit code change first

The generic bot config requires both `token0` and `token1` to resolve to a non-zero price via
`previewPrices`. ARMY has none, by design (§2). Do not work around this by pointing `token1` at an unrelated
priced asset — that would silently value ARMY at the wrong price, which is worse than the current
"valued at 0" design.

The correct fix: a small, explicit fork of `computePublishedPriceMantissa` for this one pool that hardcodes
`price1E18 = 0n` (so the formula collapses to pricing the XRP-side reserve only), or an opt-in "zero-price
side" flag added to the config schema. Either way, this is a deliberate code change, not a config value —
flag it for review before shipping, and keep the XRP/USDC pool live independently of when this one is ready.

## 6. Safety checks the bot already enforces — don't bypass them

Already implemented, don't disable: reject if `amm_info` fails or any reserve/LP supply is 0; reject if
either underlying price is 0; reject below `minTvlUsd`; reject if one side exceeds ~95% of pool value; reject
on a >15% price move without manual confirmation; require re-confirmation on an abnormal reserve jump. Full
detail: [15-xrpl-lp-oracle-bot.md](15-xrpl-lp-oracle-bot.md) §8.

## 7. What changes on the LP prices page once this is live

Once the bot posts a real price, `fallbackPriceOf` for that asset will show a non-zero `priceMantissa` and a
real `updatedAt`. The "Market not open yet" / "Oracle price not published yet" states on
`https://mainnet.securd.fi/lp-prices` should switch automatically to showing the real value and a staleness
indicator — confirm this actually happens rather than assuming the frontend logic handles it (and see
[dapp-lp-prices-page-copy-fix-prompt.md](dapp-lp-prices-page-copy-fix-prompt.md) for the separate copy fix
needed on that same page before this goes live, so the "Oracle price vs DEX value" framing doesn't read as
two independent prices disagreeing).

**Posting a price alone does not make these markets usable as collateral.** Both LP markets currently read a
**0% collateral factor on-chain**, due to a separate, already-documented deploy-time bug (`_setCollateralFactor`
silently no-op'd while price was 0). That needs its own fix through the 48h `CollateralFactorTimelock`, by the
owner, once a real price is flowing — not part of this doc's scope, but don't expect LP collateral to work
immediately after the bot starts posting.

## 8. Runbook summary

1. Developer generates a fresh key, sends Mohamed only the public address.
2. Mohamed authorizes it via `setAssetOracle` for both LP underlyings (§3), verifies with the read-only `cast
   call`.
3. Developer creates `config/xrpl-lp-oracle-mainnet.json` (§4), sets `LP_ORACLE_PRIVATE_KEY` locally, runs the
   validator then the bot for XRP/USDC.
4. Confirm on-chain: `fallbackPriceOf` for the XRP/USDC underlying shows a non-zero price and a fresh
   `updatedAt`.
5. Confirm the LP prices page picks it up correctly (§7).
6. ARMY pool: implement the zero-price-side fix (§5) as a separate, reviewed change before running the bot
   for that pool.
7. Separately, the collateral-factor fix (§7, last paragraph) before either market is presented as usable
   collateral.

## 9. Self-review of this document

- Confirmed live, not assumed: both LP markets' `oracleType`/`fallbackMaxDelay` are already `3`/`900`;
  `isAssetOracle` is `false` for every address today on both; current AMM reserves and LP supply match what's
  shown on the live LP prices page.
- Verified the `onlyAssetOracle` modifier directly from `SecurdPriceOracle.sol` source — confirmed this
  authorization has no effect beyond `postFallbackPrice` for the specified asset.
- Correctly distinguished two unrelated "USDC issuer" concerns (AMM-pricing vs. bridging) so this doc doesn't
  contradict the bridging-specific guidance elsewhere in the repo.
- Flagged the ARMY zero-price-side gap as a real code change, not glossed over as a config value, since the
  schema genuinely can't express it today.
- Did not include any private key, placeholder or otherwise, anywhere in this document, per §0.
