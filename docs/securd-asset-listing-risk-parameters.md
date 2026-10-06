# Securd — Asset Listing & Risk Parameters
**DeFi Risk Report | XRPL EVM Mainnet (Chain ID 1440000) & XRP Ledger Mainnet**
**Author: Securd Labs — Risk Management Team**
**Date: 2026-05-28 | All data verified on-chain**

---

## Executive Summary

| Category | Available Today | Future |
|----------|----------------|--------|
| Single assets | XRP, USDC, WETH, WBTC, USDT, mXRP | RLUSD |
| LP tokens | XRP/RLUSD, XRP/USDC, XRP/ARMY — Axelar ITS registration in progress | — |

> WBTC ($241 total supply) and USDT ($207 total supply) are deployed on XRPL EVM but require seeding before activation as meaningful markets.
> Axelar is actively working on registering XRPL native AMM LP tokens in ITS to make them bridgeable to XRPL EVM. Parameters are defined and ready for deployment upon registration completion.

> **2026-06-20 update:** On-chain verification of issuer flags found that RLUSD's
> issuer has `lsfAllowTrustLineClawback = TRUE`. Axelar's lock/unlock bridge model means
> the XRPL custodial multisig holds one pooled LP position backing *all* wrapped
> XRP/RLUSD LP holders on XRPL EVM combined — `AMMClawback` (live on mainnet) could
> liquidate that entire position in one transaction, leaving the wrapped supply unbacked.
> **XRP/RLUSD LP is on hold pending an explicit risk decision** — see "Issuer Risk Flags"
> under XRP/RLUSD LP below. XRP/USDC LP and XRP/ARMY LP have no clawback risk (confirmed
> on-chain: `lsfAllowTrustLineClawback = FALSE` for both) and remain clear to proceed,
> though both retain a recoverable freeze risk shared by all three pools (see below).

---

## Risk Parameter Definitions

| Parameter | Description |
|-----------|-------------|
| **Collateral Factor (CF)** | Maximum percentage of collateral value that can be borrowed against. A CF of 75% means a user depositing $100 can borrow up to $75. Liquidation is triggered as soon as the borrowed value exceeds CF × collateral value. |
| **Close Factor** | Maximum percentage of a borrower's outstanding debt that a liquidator can repay in a single transaction. Set at 50% for all markets to prevent full liquidation in one block. |
| **Reserve Factor** | Percentage of borrower interest redirected to the protocol insurance reserve instead of suppliers. At 20%, if borrowers pay 10% APY, suppliers receive 8% APY and 2% accrues to the reserve. |
| **Supply Cap** | Maximum total amount of an asset that can be deposited into the market. Limits protocol exposure to any single asset. |
| **Borrow Cap** | Maximum total amount that can be borrowed from the market. Set at 80% of supply cap to guarantee a minimum 20% liquidity buffer for supplier withdrawals at all times. |
| **Liquidation Incentive (LI)** | Bonus paid to liquidators expressed as a percentage of the debt repaid. A 10% LI means a liquidator repaying $100 of debt receives $110 worth of collateral. |
| **IR — Base Rate** | Minimum annual borrow rate regardless of utilization. |
| **IR — Slope 1** | Rate of interest increase per unit of utilization below the kink (normal regime). |
| **IR — Slope 2** | Rate of interest increase per unit of utilization above the kink (stress regime). Intentionally steep to force repayment and attract new supply when the market approaches full utilization. |
| **IR — Kink** | Optimal utilization target. Below this level interest rates are low and stable; above it rates rise sharply to protect liquidity. |

**Health Factor (HF):**
```
HF = Σ(collateral_i × CF_i × price_i) / Σ(borrow_j × price_j)
```
Liquidation is triggered when **HF < 1.0**. Maximum borrowing is reached when HF = 1.0.

---

# PART 1 — SINGLE ASSETS AVAILABLE TODAY

---

## XRP

**What it is:** Native gas token of XRPL EVM. 6th largest crypto asset globally, with the deepest on-chain liquidity of any asset in this ecosystem.

**Market data (live):**
- Price: **$1.39** | Supply: Native | Liquidity: Deepest on-chain — all AMMs are XRP-denominated

**Role:** Collateral + borrowable

**Risk profile:**
- Volatility: High. XRP has experienced 80–90% drawdowns in bear cycles.
- Liquidation note: For positions where HF drops below 0.825, partial liquidations reduce borrower equity faster than debt is relieved. The protocol bad debt insurance reserve absorbs residual exposure.
- Oracle: XRP/RLUSD AMM TWAP (primary) + Bitstamp DEX order book (secondary). Max staleness: 200 ledgers.
- Smart contract risk: None — native asset.

| Parameter | Value |
|-----------|-------|
| **Collateral Factor** | **75%** |
| **Close Factor** | **50%** |
| **Reserve Factor** | **20%** |
| **Supply Cap** | **3,500,000 XRP** |
| **Borrow Cap** | **2,800,000 XRP** |
| **Liquidation Incentive** | **10%** |
| **IR — Base Rate** | **0%** |
| **IR — Slope 1** | **5%/year** |
| **IR — Slope 2** | **85%/year** |
| **IR — Kink** | **80%** |

**Borrow APY at utilization:**
- 50% → 2.5% | 80% → 4.0% *(kink)* | 95% → 16.75%

---

## USDC (Axelar)

**EVM address:** `0xa16148c6Ac9EDe0D82f0c52899e22a575284f131`
**XRPL issuer (Axelar gateway):** `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`

**Market data (live):**
- Price: ~$1.00 | 4,153 USDC on XRPL EVM | $956K AMM TVL | $129K 7d volume

**Role:** Collateral + borrowable

**Risk profile:**
- Stability: Excellent — regulated stablecoin, monthly reserve attestations by Circle.
- Bridge risk: Axelar-wrapped. If the bridge is compromised, USDC becomes unbacked.
- Oracle: XRP/USDC AMM TWAP × XRP/USD. Circuit breaker if price < $0.97 or > $1.05. Max staleness: 200 ledgers.

| Parameter | Value |
|-----------|-------|
| **Collateral Factor** | **80%** |
| **Close Factor** | **50%** |
| **Reserve Factor** | **20%** |
| **Supply Cap** | **50,000 USDC** |
| **Borrow Cap** | **40,000 USDC** |
| **Liquidation Incentive** | **5%** |
| **IR — Base Rate** | **0%** |
| **IR — Slope 1** | **8%/year** |
| **IR — Slope 2** | **75%/year** |
| **IR — Kink** | **90%** |

**Borrow APY at utilization:**
- 50% → 4.0% | 90% → 7.2% *(kink)* | 95% → 10.95% | 100% → 14.7%

---

## USDT (Axelar)

**EVM address:** `0x9F8CF9c00fac501b3965872f4ed3271f6f4d06fF`
**XRPL issuer (Axelar gateway):** `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`

**Market data (live):**
- Price: ~$1.00 | **207 USDT** on XRPL EVM | $217K AMM TVL | $25K 7d volume

**Role:** Collateral + borrowable

**Risk profile:**
- Stability: Good — most widely used stablecoin globally; reserve composition less transparent than Circle.
- Bridge risk: Same Axelar wrapping as USDC.
- Oracle: XRP/USDT AMM TWAP × XRP/USD. TWAP window extended to 50 ledgers given thinner AMM depth. Max staleness: 200 ledgers.
- **Minimum seeding required before activation: $10,000 USDT.** Activating on an empty market exposes the protocol to initial exchange rate manipulation.

| Parameter | Value |
|-----------|-------|
| **Collateral Factor** | **78%** |
| **Close Factor** | **50%** |
| **Reserve Factor** | **20%** |
| **Supply Cap** | **50,000 USDT** |
| **Borrow Cap** | **40,000 USDT** |
| **Liquidation Incentive** | **5%** |
| **IR — Base Rate** | **0%** |
| **IR — Slope 1** | **8%/year** |
| **IR — Slope 2** | **75%/year** |
| **IR — Kink** | **90%** |

**Borrow APY at utilization:**
- 50% → 4.0% | 90% → 7.2% *(kink)* | 95% → 10.95% | 100% → 14.7%

---

## WETH (Axelar)

**EVM address:** `0x50498dC52bCd3dAeB54B7225A7d2FA8D536F313E`
**XRPL issuer (Axelar gateway):** `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`

**Market data (live):**
- Price: ~$2,127 (1,530 XRP/WETH × $1.39) | **2.577 WETH** (~$5,482) on XRPL EVM | 104.7 WETH bridged on XRPL

**Role:** Collateral + borrowable

**Risk profile:**
- Volatility: High. ETH has experienced 80%+ drawdowns in bear markets. Positions below HF = 0.825 generate bad debt under partial liquidation.
- Bridge risk: Axelar wrapping — same risk profile as USDC.
- Oracle: WETH/XRP XRPL DEX TWAP × XRP/USD. Falls back to XRPL ledger DEX if WETH EVM DEX liquidity < $10K. Max staleness: 200 ledgers.
- **Minimum seeding: 1 WETH before activating.**

| Parameter | Value |
|-----------|-------|
| **Collateral Factor** | **75%** |
| **Close Factor** | **50%** |
| **Reserve Factor** | **20%** |
| **Supply Cap** | **20 WETH** |
| **Borrow Cap** | **16 WETH** |
| **Liquidation Incentive** | **10%** |
| **IR — Base Rate** | **0%** |
| **IR — Slope 1** | **5%/year** |
| **IR — Slope 2** | **82%/year** |
| **IR — Kink** | **85%** |

**Borrow APY at utilization:**
- 50% → 2.5% | 85% → 4.25% *(kink)* | 95% → 12.45%

**Supply cap roadmap:** 20 → 50 → 100 WETH. Each step requires 2 weeks of stable operation at the prior level.

---

## WBTC (Axelar)

**EVM address:** `0xF8Eb4Ed0d4CF2bb707c0272F8C6827dEB6e4C0A9`
**XRPL issuer (Axelar gateway):** `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`

**Market data (live):**
- Price: ~$105,000 | **0.002 WBTC** (~$241) on XRPL EVM | 0.0067 BTC bridged on XRPL

**Role:** Collateral + borrowable (once seeded)

**Risk profile:**
- Volatility: High. BTC experiences 70–80% drawdowns in bear cycles.
- Bridge risk: Axelar wrapping adds custodial risk on top of the underlying asset.
- Oracle: WBTC/XRP on the **XRPL ledger DEX** × XRP/USD — XRPL EVM DEX has near-zero WBTC liquidity and cannot serve as a reliable price source. Collateral use remains disabled until XRPL EVM DEX liquidity exceeds $50,000.
- **Minimum seeding: 0.1 WBTC before activating.**

| Parameter | Value |
|-----------|-------|
| **Collateral Factor** | **73%** *(disabled for collateral use until DEX liquidity > $50K)* |
| **Close Factor** | **50%** |
| **Reserve Factor** | **20%** |
| **Supply Cap** | **0.75 WBTC** |
| **Borrow Cap** | **0.60 WBTC** |
| **Liquidation Incentive** | **10%** |
| **IR — Base Rate** | **0%** |
| **IR — Slope 1** | **5%/year** |
| **IR — Slope 2** | **82%/year** |
| **IR — Kink** | **80%** |

**Borrow APY at utilization:**
- 50% → 2.5% | 80% → 4.0% *(kink)* | 95% → 16.3%

---

## mXRP (Midas)

**EVM address:** `0x06e0B0F1A644Bb9881f675Ef266CeC15a63a3d47`

**Market data (live):**
- Price: ~$1.44 (1.035 XRP × $1.39) | **3,756,955 mXRP** (~$5.4M) on XRPL EVM | 2,384 XRPL holders

**Role:** Collateral only — no borrowing

**Risk profile:**
- Midas protocol risk: If Midas is exploited or becomes insolvent, mXRP depegs from XRP. The 3.5% premium disappears instantly under stress.
- Double risk layer: Midas smart contract + Axelar bridge — two independent failure points.
- Oracle: mXRP/XRP DEX TWAP × XRP/USD. Price is hard-capped at `min(live_price, 1.06 × XRP_USD)` to prevent manipulation via premium inflation.
- Borrow cap set to zero — circular leverage must be prevented.

| Parameter | Value |
|-----------|-------|
| **Collateral Factor** | **60%** |
| **Close Factor** | **50%** |
| **Reserve Factor** | **20%** |
| **Supply Cap** | **5,500,000 mXRP** |
| **Borrow Cap** | **0** — supply only |
| **Liquidation Incentive** | **10%** |
| **IR — Base Rate** | N/A — no borrowing market |
| **IR — Slope 1** | N/A |
| **IR — Slope 2** | N/A |
| **IR — Kink** | N/A |

**Monitoring triggers:** mXRP/XRP < 0.98 → reduce CF to 50%. mXRP/XRP < 0.95 → pause market.

---

# PART 2 — LP TOKENS (AXELAR ITS REGISTRATION IN PROGRESS)

Axelar is actively working on registering XRPL native AMM LP tokens in its Interchain Token Service (ITS), which will make them bridgeable to XRPL EVM as standard ERC-20 tokens. The risk parameters below are defined and approved — markets will be deployed on Securd as soon as each LP token's Axelar ITS registration is confirmed.

LP tokens are accepted as **collateral only**. They cannot be borrowed, and suppliers do not earn interest on deposited LP tokens. Their sole purpose is to unlock borrowing capacity against an existing LP position. Accordingly, no interest rate model applies to these markets and the reserve factor is 0% as no interest income is generated.

**Technical requirements upon Axelar registration:**
1. LP token registered in Axelar ITS with MINT_BURN token manager
2. AMM account on XRPL authorizes Axelar to issue the LP token cross-chain
3. Lending market deployed on XRPL EVM for the bridged LP token
4. Oracle contract deployed with validation guard: `require(lp_supply > 0 && xrp_reserve > 0 && stable_reserve > 0)`

---

## XRP/RLUSD LP — ON HOLD (was Priority 1)

> **Issuer risk flags (verified on-chain, 2026-06-20):** RLUSD issuer
> `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` has `lsfAllowTrustLineClawback = TRUE` and
> `lsfNoFreeze = FALSE` (currently not frozen — `lsfGlobalFreeze = FALSE` — but Ripple
> retains the power).
>
> **Clawback (catastrophic, permanent):** `AMMClawback` (XLS-73d, live on mainnet since
> rippled 2.3.0) lets Ripple target the Axelar custodial multisig directly, force a full
> withdrawal of its pooled LP position, claw back the RLUSD portion, and return the XRP
> portion. Because the multisig holds one custodial position backing *all* wrapped
> XRP/RLUSD LP holders on XRPL EVM combined (not per-user), this could unbacked the
> entire wrapped supply in a single transaction, with no automatic adjustment on the
> EVM side.
>
> **Freeze (total but recoverable):** if RLUSD is frozen on the multisig's trust line
> (or globally), the multisig's LP token becomes untransferable *and* `AMMWithdraw`
> against it fails with `tecFROZEN` — there is no transfer path and no withdraw path
> out of the pool. XRP itself can't be frozen directly, but the XRP bundled inside that
> LP position becomes inaccessible by association until Ripple lifts the freeze.
>
> **Action required before listing:** explicit decision to accept clawback exposure, or
> a mitigation (e.g., insurance reserve sized to this pool's TVL, or excluding RLUSD
> until Ripple's clawback stance on bridged custodial positions is clarified).
> Do not deploy this market until resolved.

| Pool data | Value |
|-----------|-------|
| **XRPL AMM account** | `rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3` |
| **LP token currency (XRPL)** | `037C2A57B0011520DE389E332043EC0FAF858ACE` |
| **LP token issuer (XRPL)** | `rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3` |
| **XRP reserve** | 1,893,541 XRP |
| **RLUSD reserve** | 2,499,660 RLUSD |
| **LP token supply** | 3,165,547,749 |
| **TVL** | $5.26M |
| **7d volume** | $636K |
| **Pool fee** | 0.267% |
| **LP annual yield** | 2.9% |

**Role:** Collateral only — cannot be borrowed, no interest earned on deposit

**Oracle formula (geometric mean — manipulation resistant):**
```
LP_price_USD = 2 × sqrt(XRP_reserve × P_xrp × RLUSD_reserve × 1.00) / LP_supply
```
*Current LP unit price: 2 × sqrt(1,893,541 × $1.39 × 2,499,660) / 3,165,547,749 ≈ $0.00166*

| Parameter | Value |
|-----------|-------|
| **Collateral Factor** | **62%** |
| **Close Factor** | **50%** |
| **Reserve Factor** | **0%** — collateral-only market, no interest income |
| **Supply Cap** | $526,000 worth of LP tokens |
| **Borrow Cap** | **0** — collateral only |
| **Liquidation Incentive** | **10%** |
| **IR — Base Rate** | N/A — no borrowing market |
| **IR — Slope 1** | N/A |
| **IR — Slope 2** | N/A |
| **IR — Kink** | N/A |

---

## XRP/USDC LP — Priority 1 (was Priority 2)

> **Issuer risk flags (verified on-chain, 2026-06-20):** USDC issuer
> `rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE` has `lsfAllowTrustLineClawback = FALSE` — no
> clawback risk, clear to proceed. It does have `lsfNoFreeze = FALSE` (freeze power
> retained): if USDC is ever frozen on the multisig's trust line, the multisig's
> XRP/USDC LP token becomes untransferable and `AMMWithdraw` fails with `tecFROZEN`
> until lifted — same mechanism as RLUSD, but recoverable rather than permanent, and not
> a reason to delay listing.

| Pool data | Value |
|-----------|-------|
| **XRPL AMM account** | `rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE` |
| **LP token currency (XRPL)** | `03USDC_LP` *(resolved on Axelar ITS registration)* |
| **LP token issuer (XRPL)** | `rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE` |
| **XRP reserve** | 343,875 XRP |
| **USDC reserve** | 343,875 USDC (approx.) |
| **TVL** | $956K |
| **7d volume** | $129K |
| **Pool fee** | 0.202% |
| **LP annual yield** | 2.7% |

**Role:** Collateral only — cannot be borrowed, no interest earned on deposit

**Oracle formula:** `LP_price_USD = 2 × sqrt(XRP_reserve × P_xrp × USDC_reserve × 1.00) / LP_supply`

| Parameter | Value |
|-----------|-------|
| **Collateral Factor** | **57%** |
| **Close Factor** | **50%** |
| **Reserve Factor** | **0%** — collateral-only market, no interest income |
| **Supply Cap** | $95,600 worth of LP tokens |
| **Borrow Cap** | **0** — collateral only |
| **Liquidation Incentive** | **10%** |
| **IR — Base Rate** | N/A — no borrowing market |
| **IR — Slope 1** | N/A |
| **IR — Slope 2** | N/A |
| **IR — Kink** | N/A |

---

## XRP/ARMY LP — Priority 2 (was Priority 3; conditional on external price feed)

> **Issuer risk flags (verified on-chain, 2026-06-20):** ARMY issuer
> `rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC` has `lsfAllowTrustLineClawback = FALSE` — no
> clawback risk, clear to proceed. It does have `lsfNoFreeze = FALSE` (freeze power
> retained): if ARMY is ever frozen on the multisig's trust line, the multisig's
> XRP/ARMY LP token becomes untransferable and `AMMWithdraw` fails with `tecFROZEN`
> until lifted — same mechanism as RLUSD, but recoverable rather than permanent, and not
> a reason to delay listing.

**Additional condition:** ARMY token must have an external price feed independent of this pool (CoinGecko listing or centralized exchange) before this market can be activated.

| Pool data | Value |
|-----------|-------|
| **XRPL AMM account** | `rnsRq5ahgbFeRiAgBVvFTafyAgiS9x9Ztn` |
| **LP token currency (XRPL)** | `037C2A57B0011520DE389E332043EC0FAF858ACE` *(ARMY pool LP currency — different from RLUSD pool)* |
| **LP token issuer (XRPL)** | `rnsRq5ahgbFeRiAgBVvFTafyAgiS9x9Ztn` |
| **ARMY token issuer** | `rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC` |
| **XRP reserve** | 244,601 XRP |
| **ARMY reserve** | 41,500,094 ARMY |
| **LP token supply** | 3,165,547,749 |
| **TVL** | ~$680K |
| **7d volume** | Low (0.001% fee generates minimal volume signal) |
| **Pool fee** | 0.001% |
| **LP annual yield** | ~0% |

**Role:** Collateral only — cannot be borrowed, no interest earned on deposit

**Oracle:** `LP_price_USD = 2 × XRP_reserve × P_xrp / LP_supply` *(shortcut: valid only when the pool is exactly 50/50 in USD at oracle prices. For any other pool, use the fair value `2 × sqrt(R_x × P_x × R_y × P_y) / L`, see `docs/lp-price-calculation-spec.md` §2.)*
ARMY is priced at $0 — only the XRP side of the pool is credited. This is conservative by design: if ARMY holds any market value, the actual collateral exceeds Securd's credit.

*Current LP unit price (XRP-only): 2 × 244,601 × $1.39 / 3,165,547,749 ≈ $0.000215*

| Parameter | Value |
|-----------|-------|
| **Collateral Factor** | **35%** |
| **Close Factor** | **50%** |
| **Reserve Factor** | **0%** — collateral-only market, no interest income |
| **Supply Cap** | $34,000 worth of LP tokens |
| **Borrow Cap** | **0** — collateral only |
| **Liquidation Incentive** | **15%** |
| **IR — Base Rate** | N/A — no borrowing market |
| **IR — Slope 1** | N/A |
| **IR — Slope 2** | N/A |
| **IR — Kink** | N/A |

---

# PART 3 — FUTURE LISTINGS

*Asset not yet available on XRPL EVM mainnet.*

---

## RLUSD

**What it is:** Ripple's regulated USD stablecoin. NYDFS-licensed, backed 1:1 by USD deposits and US T-Bills. Deepest liquidity on XRPL ($5.26M in XRP/RLUSD AMM, $636K 7d volume).

**Current status:** XRPL-native only. Not yet on XRPL EVM.

**Listing trigger:** RLUSD bridged to XRPL EVM with > $100,000 supply.

| Parameter | Value |
|-----------|-------|
| **Collateral Factor** | **83%** |
| **Close Factor** | **50%** |
| **Reserve Factor** | **20%** → reduce to 10% once insurance fund > $100K |
| **Supply Cap** | **2,000,000 RLUSD** |
| **Borrow Cap** | **1,600,000 RLUSD** |
| **Liquidation Incentive** | **5%** |
| **IR — Base Rate** | **0%** |
| **IR — Slope 1** | **8%/year** |
| **IR — Slope 2** | **75%/year** |
| **IR — Kink** | **90%** |

**Borrow APY at utilization:**
- 50% → 4.0% | 90% → 7.2% *(kink)* | 95% → 10.95% | 100% → 14.7%

---

# PART 4 — COMPLETE PARAMETER SUMMARY

## Single asset markets

| Asset | CF | Close Factor | Liq. Incentive | Reserve Factor | Supply Cap | Borrow Cap | IR Kink |
|-------|---:|:---:|---:|---:|---|---|---:|
| XRP | 75% | 50% | 10% | 20% | 3,500,000 XRP | 2,800,000 XRP | 80% |
| USDC | 80% | 50% | 5% | 20% | 50,000 USDC | 40,000 USDC | 90% |
| USDT | 78% | 50% | 5% | 20% | 50,000 USDT | 40,000 USDT | 90% |
| WETH | 75% | 50% | 10% | 20% | 20 WETH | 16 WETH | 85% |
| WBTC †| 73% | 50% | 10% | 20% | 0.75 WBTC | 0.60 WBTC | 80% |
| mXRP | 60% | 50% | 10% | 20% | 5,500,000 mXRP | 0 | N/A |

†  WBTC collateral use disabled until XRPL EVM DEX liquidity > $50K

## LP token markets (Axelar ITS registration in progress)

| Asset | CF | Close Factor | Liq. Incentive | Reserve Factor | Supply Cap | Borrow Cap | Status |
|-------|---:|:---:|---:|---:|---|---|---|
| XRP/RLUSD LP | 62% | 50% | 10% | 0% | $526,000 | 0 | **ON HOLD** — issuer clawback-capable § |
| XRP/USDC LP | 57% | 50% | 10% | 0% | $95,600 | 0 | Clear to proceed |
| XRP/ARMY LP ‡ | 35% | 50% | 15% | 0% | $34,000 | 0 | Clear to proceed |

‡  XRP/ARMY LP requires external ARMY price feed before activation
§  RLUSD issuer has `lsfAllowTrustLineClawback = TRUE` (verified on-chain 2026-06-20);
   `AMMClawback` against the Axelar custodial multisig could unbacked the entire wrapped
   LP supply. Hold until explicitly accepted or mitigated — see XRP/RLUSD LP section.

## Future markets

| Asset | CF | Liq. Incentive | Reserve Factor | Listing trigger |
|-------|---:|---:|---:|---|
| RLUSD | 83% | 5% | 20% | Bridged to XRPL EVM > $100K supply |

---

# PART 5 — INTEREST RATE MODELS

Interest rates follow a two-slope model with a utilization kink. Below the kink, rates rise gradually to balance supply and demand. Above the kink, rates accelerate sharply to incentivize new supply and encourage borrower repayment before the market reaches full utilization.

**Formula:**
```
borrowRate(u) = Slope1 × u                                  when u ≤ kink
borrowRate(u) = Slope1 × kink + Slope2 × (u − kink)        when u > kink
supplyRate(u) = borrowRate(u) × (1 − reserveFactor) × u
```

| Asset | Slope 1 | Slope 2 | Kink | Rate at kink | Rate at 100% |
|-------|--------:|--------:|-----:|-------------:|-------------:|
| XRP | 5%/yr | 85%/yr | 80% | 4.00% | 17.75% |
| USDC | 8%/yr | 75%/yr | 90% | 7.20% | 14.70% |
| USDT | 8%/yr | 75%/yr | 90% | 7.20% | 14.70% |
| WETH | 5%/yr | 82%/yr | 85% | 4.25% | 16.05% |
| WBTC | 5%/yr | 82%/yr | 80% | 4.00% | 16.40% |
| RLUSD | 8%/yr | 75%/yr | 90% | 7.20% | 14.70% |
| mXRP | N/A | N/A | N/A | N/A | N/A |
| LP tokens | N/A | N/A | N/A | N/A | N/A |

---

# PART 6 — ORACLE ARCHITECTURE

Reliable price feeds are the most critical component of any lending protocol. An incorrect or manipulated price can allow under-collateralized borrowing or prevent valid liquidations. Securd uses on-chain price sources with time-weighted averaging and multiple protective layers.

## How prices are computed

### Native XRP
XRP price is derived from two independent on-chain sources and cross-checked against each other:
1. **Primary:** Time-weighted average of the XRP/RLUSD AMM pool reserve ratio over the last 20 XRPL ledgers (~20 seconds). The $5.26M TVL of this pool makes large price manipulation extremely expensive.
2. **Secondary:** Bitstamp USD/XRP order book on the XRPL native DEX, used as a sanity check. If the two sources diverge by more than 3%, the oracle raises an alert.

### Stablecoins (USDC, USDT, RLUSD)
Stablecoin prices are treated as $1.00 by default. The oracle continuously monitors the on-chain AMM ratio:
- USDC: derived from the XRP/USDC AMM pool (TVL $956K) — `P_usdc = P_xrp / (XRP_reserve / USDC_reserve)`
- USDT: derived from the XRP/USDT AMM pool (TVL $217K) — same ratio formula, 50-ledger TWAP to compensate for thinner liquidity
- RLUSD: fixed at $1.00 with AMM ratio as secondary validation

If the derived stablecoin price deviates from $1.00 by more than 3% in either direction, the circuit breaker activates.

### Wrapped assets (WETH, WBTC)
Prices are computed in two steps:
1. Derive the asset/XRP ratio from the XRPL DEX TWAP (20 ledgers)
2. Multiply by the XRP/USD price

`P_weth = (WETH/XRP DEX TWAP) × P_xrp`

WBTC uses the XRPL ledger DEX (not the XRPL EVM DEX, which has near-zero WBTC liquidity). Collateral use is disabled until XRPL EVM DEX liquidity exceeds $50K.

### mXRP
`P_mxrp = min(mXRP/XRP DEX TWAP × P_xrp,  1.06 × P_xrp)`

The hard cap at 1.06× prevents an attacker from pumping the mXRP/XRP premium to extract inflated borrowing power. The cap is reviewed quarterly against the observed trading premium.

### LP tokens
LP token value is derived using the geometric mean of pool reserves, which is resistant to single-block manipulation:

**XRP/Stablecoin pairs:**
```
LP_price_USD = 2 × sqrt(XRP_reserve × P_xrp × Stable_reserve × 1.00) / LP_supply
```

**XRP/ARMY (conservative):**
```
LP_price_USD = 2 × XRP_reserve × P_xrp / LP_supply
```
ARMY is valued at $0 — the LP price reflects only the XRP side. This is deliberately conservative: if ARMY holds any market value, the actual collateral is worth more than Securd credits.

**Oracle guard (required in contract):**
```solidity
require(lp_supply > 0 && xrp_reserve > 0 && stable_reserve > 0, "invalid pool state");
```

## TWAP parameters

| Asset | TWAP window | Rationale |
|-------|-------------|-----------|
| XRP | 20 ledgers | Deep liquidity ($5.26M AMM) — short window sufficient |
| USDC | 20 ledgers | Deep liquidity ($956K AMM) |
| USDT | 50 ledgers | Thinner liquidity ($217K AMM) — wider window reduces manipulation risk |
| WETH | 20 ledgers | XRPL DEX volume is sufficient |
| WBTC | 20 ledgers | XRPL ledger DEX is used |
| mXRP | 20 ledgers | mXRP/XRP premium is stable; capped independently |
| LP tokens | 20 ledgers | Pool reserves sampled per ledger; geometric mean absorbs outliers |

## Staleness protection

If an oracle has not been updated within the defined window, the protocol escalates through three stages:

| Stage | Condition | Action |
|-------|-----------|--------|
| **Stale** | Last update > 200 ledgers | Block new borrows using this price; existing positions unaffected |
| **Critical** | Last update > 1,000 ledgers (~17 min) | Full market pause — no borrows, no new collateral deposits |
| **Recovery** | Price feed restored | Manual admin review required before un-pausing |

## Circuit breakers

| Asset | Trigger | Action |
|-------|---------|--------|
| XRP | Price moves > 20% in 1 hour | Pause new borrows; alert governance |
| USDC / USDT / RLUSD | Price < $0.97 or > $1.05 | Auto-pause market |
| WETH | Price moves > 15% in 1 hour | Pause new borrows |
| WBTC | Price moves > 15% in 1 hour | Pause new borrows |
| WBTC | XRPL EVM DEX liquidity < $50K | CF = 0; deposit and borrow allowed, no collateral use |
| mXRP | mXRP/XRP ratio < 0.98 | CF reduced to 50% |
| mXRP | mXRP/XRP ratio < 0.95 | Full market pause |
| LP tokens | XRP reserve changes > 15% in one ledger | Pause LP oracle and market |

---

# PART 7 — LIQUIDATION MECHANICS & BAD DEBT

## Liquidation flow

When a borrower's Health Factor drops below 1.0, any address can trigger a liquidation:
1. Liquidator selects a borrower with HF < 1.0 and a market to repay
2. Liquidator repays up to 50% of the borrower's outstanding debt in that market (close factor)
3. Liquidator receives collateral worth `debt_repaid × (1 + liquidation_incentive)` at the oracle price
4. Borrower's HF rises; if still < 1.0, further liquidations are possible

## Bad debt threshold

In this protocol's liquidation model, partial liquidation only improves the borrower's HF when `HF > CF × (1 + LI)`. Below this threshold, each partial liquidation reduces the borrower's collateral faster than it reduces debt, and the position generates bad debt. The protocol insurance reserve (funded by the reserve factor) absorbs this shortfall.

| Asset | CF | Liq. Incentive | Bad debt if HF below |
|-------|---:|---:|---:|
| XRP | 75% | 10% | **0.825** |
| USDC | 80% | 5% | **0.840** |
| USDT | 78% | 5% | **0.819** |
| WETH | 75% | 10% | **0.825** |
| WBTC | 73% | 10% | **0.803** |
| mXRP | 60% | 10% | **0.660** |
| XRP/RLUSD LP | 62% | 10% | **0.682** |
| XRP/USDC LP | 57% | 10% | **0.627** |
| XRP/ARMY LP | 35% | 15% | **0.402** |

The protocol must maintain a **bad debt insurance reserve of at least 3% of total protocol TVL**, accumulated continuously from reserve factor income.

All critical parameter changes (CF, supply caps, liquidation incentive) are subject to a **48-hour governance timelock**.

---

# PART 8 — RISK WATCHLIST

| Risk | Affected assets | Trigger | Action |
|------|---|---|---|
| Axelar bridge exploit | USDC, USDT, WETH, WBTC, mXRP | Bridge TVL drops > 20% in 1h | Pause all Axelar-dependent markets |
| mXRP depeg | mXRP | mXRP/XRP < 0.98 | Reduce CF to 50% |
| mXRP depeg — severe | mXRP | mXRP/XRP < 0.95 | Pause market |
| Stablecoin depeg | USDC, USDT | Price < $0.97 | Auto-pause; manual review required |
| Oracle staleness | Any | Last update > 200 ledgers | Block new borrows |
| Oracle staleness — severe | Any | Last update > 1,000 ledgers | Full market pause |
| WBTC oracle invalid | WBTC | XRPL EVM DEX liquidity < $50K | CF = 0; deposit/borrow only |
| Bad debt accumulation | Any | Position HF < CF × (1 + LI) | Reserve fund absorption; socialization if > 2% TVL |
| XRP flash crash | XRP, all LP tokens | XRP drops > 30% in 1 ledger | Circuit breaker; pause new borrows |
| LP pool drain | LP tokens | XRP reserve moves > 15% in 1 ledger | Pause LP oracle and market |
| Governance attack | All | Admin proposes CF reduction | 48h timelock enforced before execution |
| Empty market seeding risk | USDT, WBTC | First deposit on near-empty market | Minimum $10K seed required before activation |
| RLUSD AMMClawback | XRP/RLUSD LP | Ripple executes `AMMClawback` against the Axelar custodial multisig (`lsfAllowTrustLineClawback = TRUE`, verified on-chain) | Catastrophic/permanent — entire wrapped LP supply can become unbacked in one transaction; do not list until accepted/mitigated |
| Issuer freeze → LP-token lock | XRP/RLUSD LP, XRP/USDC LP, XRP/ARMY LP | Issuer freezes the pooled asset (none of the three have `NoFreeze` set) | LP token transfer and `AMMWithdraw` both fail with `tecFROZEN` for the multisig — full but recoverable lock on the position (including the XRP side) until the issuer lifts the freeze |
