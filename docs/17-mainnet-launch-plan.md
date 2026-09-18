# Securd — XRPL EVM Mainnet Launch Plan

This document is the mainnet-specific companion to
[13-deployment-runbook.md](13-deployment-runbook.md) and
[14-release-promotion-checklist.md](14-release-promotion-checklist.md) — it fills in the
real values, phase gating, and two protocol-level caveats found while preparing this
launch, rather than repeating the generic steps those two documents already cover.

## 0. Critical fix landed: underlying-decimals oracle bug (2026-09-10)

While auditing the mainnet market set, found and fixed a critical bug:
`SecurdPriceOracle.getUnderlyingPrice()` returned a flat $-per-whole-token price
regardless of the underlying's own decimals, but `Comptroller`'s liquidity/liquidation
math multiplies that price directly against raw cToken/underlying balances, which
requires the classic Compound V2 `10^(36-underlyingDecimals)` scaling. Proven empirically
(not just by reading the code) against a live local deployment of the real contracts: a
1000 USDC (6-decimal) deposit at 80% CF registered as **$0.0000000008** of borrowing
power instead of $800 — undervalued by exactly `10^12`, matching the predicted
`10^(18-6)` factor precisely. This is a direct pool-drain vector in the dangerous
direction (a user could borrow a non-18-decimal asset like USDC for functionally free,
since the Comptroller would think that debt is worth almost nothing), not just a
usability bug. XRP, WETH, and mXRP (all 18 decimals) were unaffected, which is why it was
invisible on testnet — every live testnet market happens to be 18 decimals.

**Fix**: `SecurdPriceOracle.sol`'s `getUnderlyingPrice` now scales every oracle mode's
price by the underlying's own `decimals()` before returning it, with `previewPrices`
deliberately left unscaled (flat, for off-chain/debugging consumption — see its NatSpec
for why). A related double-scaling risk was also found and fixed:
`scripts/runXrplLpOracleBot.ts`'s `computePublishedPriceMantissa` was already doing its
own version of this same scaling before posting LP prices — left in place alongside the
contract fix, it would have silently double-applied the factor and *over*-valued LP
collateral. That pre-scaling was removed; the bot now posts flat prices and the on-chain
fix applies the scaling once, centrally, for every oracle mode. Full regression coverage
added: `test/unit/oracle.spec.ts` (decimals-scaling unit tests + a fail-safe-to-zero
case), `test/integration/comptroller.spec.ts` (end-to-end mixed 6-/18-decimal liquidity
test), `test/unit/xrplLpOracleBot.spec.ts` (confirms the bot no longer rescales). All 85
tests in the suite pass.

**Blocking implication**: this must be treated as resolved (it is, as of this commit)
before Phase 1 deploys, since Phase 1 includes USDC — the affected market with the most
severe consequence (a borrowable, non-18-decimal asset).

## 1. What's already true vs. what needs your input

**Already resolved (verified, not guessed):**
- XRPL EVM mainnet chain ID `1440000`, RPC `https://rpc.xrplevm.org`
- Axelar Gateway `0xe432150cce91c13a887f7D836923d5597adD8E31`, ITS
  `0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C` (sourced from Axelar's own
  `axelar-contract-deployments` repo, `axelar-chains-config/info/mainnet.json`)
- `XRPL_DESTINATION_CHAIN=xrpl` (cross-checked against this repo's own existing docs and
  Axelar's chain registry)
- Market token addresses, decimals, and Axelar ITS `tokenId`s for XRP, USDC, WETH, WBTC,
  USDT, mXRP, and both LP tokens — re-verified live via `eth_call` against mainnet on
  2026-09-10, not just trusted from the risk doc. mXRP's `tokenId` specifically was
  resolved via `InterchainTokenFactory.canonicalInterchainTokenId(mXRP address)` and
  cross-checked by round-tripping through `InterchainTokenService.registeredTokenAddress`
  back to the mXRP address (confirmed match) — its token contract doesn't expose
  `interchainTokenId()` directly because it's a LOCK_UNLOCK canonical registration
  (`tokenManager.implementationType() == 2`, verified), unlike USDC/USDT/WETH/WBTC which
  are native interchain tokens and answer that call directly.
- Band Protocol `StdReferenceProxy` on XRPL EVM mainnet:
  `0x6ec95bC946DcC7425925801F4e262092E0d1f83b` — verified live on 2026-09-10: has
  deployed code and returned real, sane current prices for `getReferenceData` on
  `XRP/USD` ($1.376), `USDC/USD` ($0.9998), `ETH/USD` ($2467), `WBTC/USD` ($77912),
  `USDT/USD` ($0.9996), all updated ~10 minutes before query time. `bandBaseSymbol`/
  `bandQuoteSymbol`/`bandMaxDelay` are filled in for all five BAND-mode markets (XRP,
  USDC, and Phase 2's WETH/USDT/WBTC) — note Band has no `WETH` symbol (that query
  reverted live), so the WETH market uses base symbol `ETH`; `bandMaxDelay=3600`
  (1 hour) is sized off the observed ~10-minute live update cadence with margin — revisit
  if you want it tighter.
- All risk-parameter mantissa values in `config/securd-markets-mainnet-phase1.json`,
  `config/securd-markets-mainnet-phase2-seeded.json`, and
  `config/securd-market-risk-mainnet.json`, transcribed directly from
  [securd-asset-listing-risk-parameters.md](securd-asset-listing-risk-parameters.md)

**Still needs your input before any deploy** (search these files for
`REQUIRED_BEFORE_DEPLOY` / `PLACEHOLDER_REQUIRED` / `VERIFY_BEFORE_DEPLOY`):
- `DEPLOY_OWNER`, `SECURD_PENDING_ADMIN`, `DEPLOYER_PRIVATE_KEY` — your keys/multisig,
  not something that can be sourced externally.
- Your real XRPL mainnet operating/relay account in
  `config/trusted-gmp-sources-mainnet.example.json` and
  `trusted-its-sources-mainnet.example.json` (the account that submits signed intents to
  the Axelar gateway on Securd's behalf — mirrors the testnet pattern of a specific
  account, not the gateway itself). This is an operational choice, not public data — I
  cannot look it up.
- `initialFallbackPrice` for both LP markets, and the LP oracle bot/aggregator setup —
  **explicitly deferred per team decision**.
  (mXRP's `initialFallbackPrice` *is* resolved: `1432542051067722668` = $1.432542,
  computed from a live query of the XRP/mXRP AMM pool on XRPL Ledger mainnet, account
  `rUkK6Tjwksc7PdpTDSoppFFY2VfUD4GNeJ` -- 64866.934405 XRP reserve vs 62325.55348734805
  mXRP reserve, a live 4.08% premium, cross-multiplied by the live Band XRP/USD price.
  This is a one-time bootstrap value; the fallback oracle bot must take over with the
  doc's real TWAP methodology before go-live.)
- `XRPL_EGRESS_GAS_VALUE`, guardian addresses, median-oracle-reporter config in
  `.env.mainnet.example` — operational/business choices.

**Update (2026-09-15, senior-auditor pass): the config/tooling side of this list is now
hardened, not just documented.**
- Both LP markets' `initialFallbackPrice` placeholders were **removed from
  `config/securd-markets-mainnet-phase1.json`** rather than left as the string
  `"VERIFY_BEFORE_DEPLOY"` — the field is optional (`setFallbackConfig` only needs
  `fallbackMaxDelay` to list the market), so the file now validates cleanly end-to-end
  through all five Phase-1 markets. Post the real price via `oracle.postFallbackPrice()`
  once the oracle bot is live, per §2.2/§3 below.
- `securdDeploymentConfig.ts`'s shared `assertString` now rejects any string field
  containing `REQUIRED_BEFORE_DEPLOY` / `PLACEHOLDER_REQUIRED` / `VERIFY_BEFORE_DEPLOY`
  with a clear, field-specific error. This closes exactly the silent-pass gap called out
  below for the XRPL trusted-source account: `npm run validate:deploy-inputs:mainnet-phase1`
  now hard-fails loudly on the still-unfilled
  `trusted-gmp-sources-mainnet.example.json` / `trusted-its-sources-mainnet.example.json`
  placeholders (confirmed by re-running it) instead of accepting them as valid strings.
  Grepping for these markers manually is still good practice, but the validator is no
  longer blind to them.
- `deploySecurdStack.ts` now validates `SECURD_PENDING_ADMIN`, `SECURD_PAUSE_GUARDIAN`,
  `SECURD_BORROW_CAP_GUARDIAN`, and `SECURD_MEDIAN_REPORTER_OWNER` as real addresses
  up front (previously only `DEPLOY_OWNER`/`AXELAR_GATEWAY`/`INTERCHAIN_TOKEN_SERVICE`
  were checked this way) and now **requires `SECURD_DEPLOY_MEDIAN_ORACLE_REPORTER` to be
  exactly `"true"` or `"false"` (or unset)** — previously a forgotten
  `REQUIRED_BEFORE_DEPLOY` placeholder here silently resolved to "don't deploy the
  median reporter" instead of failing loudly, quietly dropping the LP-market pricing
  safety net.
- New optional `SECURD_EXPECTED_CHAIN_ID` env var (set to `1440000` in
  `.env.mainnet.example`): `deploySecurdStack.ts` now queries the connected RPC's real
  chain id at the very start and aborts before spending any gas if it doesn't match —
  defense-in-depth against running the deploy with a stale/testnet `.env` still exported
  in your shell (neither `hardhat.config.ts` nor `package.json` auto-load a `.env` file,
  so whatever's already exported decides the network).
- New `npm run validate:deployment-record:mainnet` script, pointing at
  `deployments/xrpl-evm-mainnet.json` — step 6 below previously told you to run `npm run
  validate:deployment-record`, but that alias was (and still is, for the generic/example
  flow) hardcoded to `deployments/xrpl-evm-mainnet.example.json`, not your real output
  file.

**What's still genuinely yours to supply — no amount of tooling closes these:**
`DEPLOY_OWNER`, `SECURD_PENDING_ADMIN`, `DEPLOYER_PRIVATE_KEY`, the real XRPL trusted
operating/relay account, `XRPL_EGRESS_GAS_VALUE`, guardian addresses, and the
median-oracle-reporter config. The validator will now refuse to run to completion with
any of these still on a placeholder, but it cannot invent the real values.

## 2. Two protocol-level caveats (read before deploying)

### 2.1 Liquidation incentive is global, not per-market

`Comptroller.liquidationIncentiveMantissa` is a single protocol-wide value
(`ComptrollerStorage.sol`) — confirmed by reading the contract, not assumed. The risk doc
specifies per-asset incentives from 5% (USDC/USDT) to 15% (XRP/ARMY LP). These cannot all
be enforced simultaneously today.

**Decision (confirmed with the team):** global `SECURD_LIQUIDATION_INCENTIVE_MANTISSA =
1100000000000000000` (10%), matching the majority of the Phase-1 set (XRP, mXRP). This
makes USDC liquidations 5 points more generous to liquidators than the doc's target (safe
direction — costs the protocol somewhat more, doesn't under-collateralize anything) and
under-compensates XRP/ARMY LP liquidators by 5 points relative to the doc's 15% (the
asset the doc considered highest-risk gets the *least* extra incentive of the group — a
real, if modest, follow-up item once LP markets are live and being monitored).
Revisit if a Comptroller extension for per-market incentives is ever built.

### 2.2 No on-chain supply-cap enforcement exists

Grepped `Comptroller.sol`, `ComptrollerStorage.sol`, `CTokenInterfaces.sol`: only
`borrowCaps` exist. The risk doc's "Supply Cap" column has no contract hook. Borrow caps
*are* implemented faithfully (each market's borrow cap = 80% of its documented supply
cap, per the doc's own "20% liquidity buffer" design).

**Mitigation:** `scripts/checkSupplyCaps.ts` (new) reads live market state and compares
against `config/securd-market-risk-mainnet.json`'s `offChainSupplyCaps`, exiting non-zero
when a market is at or over target. Run this on a schedule (cron / your keeper infra) and
wire it to your alerting — it does not pause anything automatically; someone has to act
on the alert (e.g. via `Comptroller._setPauseGuardian` / the adapter's `pause()`). This is
most consequential for mXRP and the two LP markets, since (with `borrowCap = 0`) supply
cap is their *only* volume-limiting control.

## 3. Phase gating

| Phase | Markets | Gate |
|---|---|---|
| **1 — active** | XRP, USDC, mXRP, XRP/USDC LP, XRP/ARMY LP | None structural. mXRP and both LP markets use `FALLBACK` oracle mode — **do not route real user traffic to them until the fallback oracle bot + monitoring is live**, per [07-deployment-configuration.md](07-deployment-configuration.md) §7/§9. This is a precondition to flip on, not a blocker to deploying the market shell. |
| **2 — seed-gated** | WETH, USDT, WBTC | WETH needs ≥1 WETH seeded, USDT needs ≥$10k seeded, WBTC needs ≥0.1 WBTC seeded on XRPL EVM mainnet before activation (empty-market manipulation risk, per the doc). WBTC's collateral factor is additionally held at `0` (not the doc's target 73%) until XRPL EVM DEX liquidity for WBTC exceeds $50k. Configs are prepared in `config/securd-markets-mainnet-phase2-seeded.json` but **not** wired into `SECURD_MARKETS_FILE`. |
| **excluded** | XRP/RLUSD LP, RLUSD (single-asset) | XRP/RLUSD LP: unresolved `AMMClawback` risk (RLUSD issuer retains `lsfAllowTrustLineClawback`) — explicit hold in [xrpl-amm-collateral-analysis.md](xrpl-amm-collateral-analysis.md), no config prepared. RLUSD: not yet bridged to XRPL EVM. |

## 4. Deployment sequence

1. Fill in every `REQUIRED_BEFORE_DEPLOY` / `PLACEHOLDER_REQUIRED` / `VERIFY_BEFORE_DEPLOY`
   value (section 1) in a private copy of `.env.mainnet.example` and the two
   `trusted-*-sources-mainnet.example.json` files. Do not commit the filled-in `.env`.
2. `npm run typecheck`
3. `npm run validate:deploy-inputs:mainnet-phase1` — must pass with zero errors once step
   1 is complete (it currently fails intentionally on the unfilled placeholders).
4. `npm run validate:liquidation-config` / `npm run validate:lp-oracle-config` if those
   bots are already configured for mainnet.
5. `source .env.mainnet` (your filled-in copy) && `npm run deploy:full-stack` — or trigger
   the `mainnet` GitHub environment via the existing `CD` workflow
   (`.github/workflows/cd.yml`, `action: deploy-full-stack`), which already requires a
   reviewer per [16-github-actions-setup.md](16-github-actions-setup.md).
6. `npm run validate:deployment-record:mainnet` against the produced
   `deployments/xrpl-evm-mainnet.json` (the plain `validate:deployment-record` alias
   points at the generic example file, not this one).
7. `npm run accept:unitroller-admin` from the `DEPLOY_OWNER` wallet.
8. **New step — apply per-market risk parameters**, signed by `DEPLOY_OWNER` (the
   deployer key alone cannot do this — see §2 of the deployment-configuration doc and the
   admin-check in `CToken.sol`):
   ```bash
   export DEPLOYMENT_RECORD_FILE=deployments/xrpl-evm-mainnet.json
   # If DEPLOY_OWNER is a plain EOA key you control directly:
   npm run apply:market-risk-params
   # If DEPLOY_OWNER is a multisig (Safe, etc.):
   npx hardhat run scripts/applyMarketRiskParameters.ts --network xrplEvm -- --print-calldata
   # then submit the printed calldata (per market: deploy its JumpRateModelV2, then
   # _setInterestRateModel + _setReserveFactor) through your multisig UI.
   ```
9. `npm run smoke:deployment` and `npm run verify:deployment`.
10. `npm run deploy:keeper`, fund and authorize per your ops policy.
11. Start the fallback oracle bot for mXRP/XRP-USDC-LP/XRP-ARMY-LP and confirm it's
    posting before any of those markets see real user deposits.
12. Start `scripts/checkSupplyCaps.ts` on a schedule, wired to alerting.
13. Work through the go-live checklist in
    [14-release-promotion-checklist.md](14-release-promotion-checklist.md) — sections 5–6
    are unchanged by this plan.

## 5. What Phase 2 needs, later

When WETH/USDT/WBTC seeding thresholds are met: merge the relevant entry from
`config/securd-markets-mainnet-phase2-seeded.json` into the active markets file, deploy
that market (there's no dedicated "add one market" script in this repo today — either
extend `deploySecurdStack.ts`'s loop logic for a single new market or write a focused
script following the pattern in `scripts/deployStsTMarket.ts`), then re-run
`scripts/applyMarketRiskParameters.ts` for the new market's reserve factor/IRM, and raise
WBTC's collateral factor from `0` to `730000000000000000` only once XRPL EVM DEX
liquidity for WBTC is confirmed above $50k.
