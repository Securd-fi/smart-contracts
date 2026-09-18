# XRPL Native DEX AMM — LP Token Collateral Analysis for Securd

**Date:** 2026-05-28 — Fully verified: live XRPL mainnet + xrpl.to cross-check
**XRP price:** $1.39 (verified from Bitstamp order book on XRPL DEX)
**Data sources:**
- `wss://xrplcluster.com` — `amm_info` per pool (on-chain TVL)
- `api.xrpl.to/api/amm` — 24h/7d trading volume and APY
**Ledger:** #104,556,865

> ⚠️ **Correction from initial analysis:** The first scan using `ledger_data type:amm` with 100-page pagination missed the most active pools, including XRP/RLUSD ($5.26M TVL). TVL was also recalculated at correct XRP price of $1.39 (not $2.20).

---

## Top 40 Pools — Ranked by TVL (On-Chain Verified)

| # | Pair | TVL (USD) | XRP/side | 7d Volume | 24h Volume | Fee | APY |
|---|------|-----------|----------|-----------|------------|-----|-----|
| 1 | **XRP/RLUSD** | **$5,264,045** | 1,893,541 | $635,790 | $114,224 | 0.267% | 2.9% |
| 2 | XRP/FUZZY | $1,644,579 | 591,575 | $62,012 | $4,868 | 0.822% | 1.2% |
| 3 | **XRP/ARMY** | **~$680,000** | ~244,600 | — | — | 0.001% | — |
| 4 | **XRP/USDC** | **$955,972** | 343,875 | $128,879 | $25,504 | 0.202% | 2.7% |
| 5 | XRP/PHNIX | $820,041 | 294,979 | $288,671 | $74,656 | 0.335% | 15.6% |
| 6 | XRP/XLM | $389,493 | 140,105 | $122,412 | $76,625 | 0.569% | 56.9% |
| 7 | XRP/BEAR | $281,576 | 101,286 | $25,692 | $5,293 | 0.962% | 9.2% |
| 8 | XRP/EVR | $280,718 | 100,978 | $7,246 | $1,449 | 1% | 2.6% |
| 9 | XRP/DROP | $279,996 | 100,718 | $55,909 | $9,773 | 0.407% | 7.2% |
| 10 | XRP/CNY | $239,892 | 86,292 | $39,331 | $17,038 | 0.285% | 10.3% |
| 11 | XRP/mXRP | $238,064 | 85,634 | $7,634 | $1,430 | 0.439% | 1.3% |
| 12 | SHX/XRP | $222,641 | 80,087 | $19,092 | $13,324 | 0.3% | 9.1% |
| 13 | XRP/CULT | $221,875 | 79,811 | $5,551 | $142 | 1% | 0.3% |
| 14 | XRP/XRPS | $218,364 | 78,548 | $8,788 | $5,266 | 0.404% | 4.9% |
| 15 | **XRP/USDT** | **$216,574** | 77,904 | $25,128 | $17,689 | 0.296% | 12.3% |
| 16 | XRP/FARM | $165,068 | 59,377 | $126,938 | $16,745 | 0.699% | 36% |
| 17 | XRP/SLT | $153,294 | 55,142 | $27,041 | $6,999 | 0.708% | 16.4% |
| 18 | XRP/FLR | $151,119 | 54,359 | $13,427 | $1,870 | 1% | 6.3% |
| 19 | XRP/XAH | $140,951 | 50,702 | $20,200 | $1,794 | 0.994% | 6.4% |
| 20 | XRP/SOLO | $122,775 | 44,164 | $26,757 | $6,733 | 0.766% | 21.3% |
| 21 | XRP/PROFIT | $104,375 | 37,545 | $4,802 | $43 | 0.821% | 0.2% |
| 22 | XRP/XRPH | $92,338 | 33,215 | $10,951 | $1,367 | 0.996% | 7.5% |
| 23 | XRP/CSC | $84,507 | 30,398 | $20,575 | $3,196 | 0.987% | 19.3% |
| 24 | XRP/BCHAMP | $77,099 | 27,733 | $10,309 | $1,171 | 1% | 7.6% |
| 25 | XRP/SIGMA | $63,843 | 22,965 | $31,521 | $9,075 | 0.252% | 18.2% |
| 26 | XRP/OLX | $52,085 | 18,735 | $90,368 | $2,137 | 0.512% | 10.7% |
| 27 | XRP/SEAL | $50,832 | 18,285 | $12,697 | $3,202 | 1% | 32% |
| 28 | XRP/scrap | $44,957 | 16,172 | $12,187 | $2,183 | 0.649% | 16% |
| 29 | XRP/XJOY | $44,164 | 15,886 | $4,143 | $46 | 1% | 0.5% |
| 30 | XRP/xSPECTAR | $34,360 | 12,360 | $3,837 | $975 | 0.983% | 14.2% |
| 31 | XRP/CORE | $34,204 | 12,304 | $5,376 | $749 | 1% | 11.1% |
| 32 | AmericaFirst/XRP | $34,020 | 12,237 | $21,012 | $6,348 | 1% | 94.7% |
| 33 | XRP/REAL | $30,091 | 10,824 | $10,722 | $647 | 1% | 10.9% |
| 34 | XRP/X | $26,713 | 9,609 | $16,776 | $7,619 | 1% | 144.7% |
| 35 | XRP/JESTER | $26,452 | 9,515 | $37,473 | $6,375 | 0.251% | 30.5% |
| 36 | XRP/CFH | $23,779 | 8,553 | $193,036 | $28,725 | 0.126% | 77.3% |
| 37 | XRP/Xoge | $20,232 | 7,278 | $4,257 | $1,073 | 0.806% | 21.7% |
| 38 | XRP/aura | $19,942 | 7,173 | $19,657 | $506 | 0.227% | 2.9% |
| 39 | XRP/CREATE | $14,231 | 5,119 | $8,663 | $675 | 1% | 24.1% |
| 40 | XRP/RPR | $13,507 | 4,859 | $5,162 | $1,831 | 0.931% | 64% |

*XRP/ARMY TVL from separate on-chain check (pool not in top-volume list due to 0.001% fee generating minimal volume signal)*

---

## Key Insights

### Ecosystem is larger than initially found

| Metric | Initial (wrong) | Verified (correct) |
|--------|-----------------|--------------------|
| XRP price | $2.20 | **$1.39** |
| Pools found in scan | 66 | **184+** (scan incomplete) |
| XRP/RLUSD TVL | missed | **$5.26M** |
| Largest pool | ARMY ($1.07M) | **RLUSD ($5.26M)** |
| Pools > $100K TVL | 1 | **14** |
| Pools > $10K TVL | 1 | **35+** |
| Total identifiable TVL | ~$722K | **>$12M** |

### Volume anomalies (high volume relative to TVL)

| Pool | TVL | 7d Volume | Volume/TVL ratio | Interpretation |
|------|-----|-----------|------------------|----------------|
| XRP/GiB | $9,991 | $202,178 | 20× | Speculative trading, low TVL risk |
| XRP/CFH | $23,779 | $193,036 | 8× | High-frequency arbitrage pool |
| OCTOPUS/XRP | $4,608 | $42,875 | 9× | Newly active |
| $BURST/XRP | $8,078 | $48,702 | 6× | Speculative |
| XRP/RLUSD | $5,264,045 | $635,790 | 12% | Healthy stable DEX |
| XRP/USDC | $955,972 | $128,879 | 13% | Healthy stable DEX |

---

## Issuer Risk Flags — Verified On-Chain (2026-06-20)

Before bridging any LP token via Axelar's lock/unlock (XRPL) + mint/burn (XRPL EVM)
model, the issuer of each pooled asset was checked directly against the live XRPL
mainnet ledger (`account_info` on each issuer, decoding `AccountRoot` flags), not just
the report that originally proposed these three pools.

| Issuer | Account | `lsfAllowTrustLineClawback` | `lsfNoFreeze` |
|--------|---------|:---:|:---:|
| RLUSD | `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` | **TRUE** | FALSE (freeze power retained) |
| USDC | `rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE` | FALSE | FALSE (freeze power retained) |
| ARMY | `rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC` | FALSE | FALSE (freeze power retained) |

(`lsfGlobalFreeze` is currently FALSE for all three — none are frozen today; this only
checks whether the issuer *retains the power* to freeze or clawback.)

### Why this matters for a lock/unlock LP bridge specifically

In Axelar's model, the XRPL multisig gateway custodies the *single, pooled* LP token
position backing *every* wrapped LP holder on XRPL EVM combined — there is no per-user
LP position on the XRPL side, only one custodial holding.

**AMMClawback (XLS-73d, enabled on mainnet since rippled 2.3.0)** lets an issuer with
`lsfAllowTrustLineClawback` target one specific `Holder` account, force a full/partial
withdrawal of that holder's LP position, claw back the issued asset's portion, and
return the other asset to the holder. If RLUSD ever exercises this against the Axelar
multisig (the `Holder`), it doesn't skim a fraction pro-rata across all LPs — it
liquidates *the multisig's entire custodial position at once*, which is the backing for
**all** wrapped XRP/RLUSD LP holders on XRPL EVM combined. The wrapped ERC-20 supply has
no mechanism to shrink in response, so it becomes partially or fully unbacked.
Source: [AMMClawback transaction reference](https://xrpl.org/docs/references/protocol/transactions/types/ammclawback), [Known Amendments](https://xrpl.org/resources/known-amendments).

**Freeze locks both sides of the position, not just LP-token transfer.** Two separate
rules stack: (1) *"If an LP token is associated with a liquidity pool that contains at
least one frozen asset, the LP token is also frozen"* — the multisig can't send its LP
token to anyone; (2) `AMMWithdraw` against a frozen-pool position independently fails
with `tecFROZEN` — confirmed in the transaction reference's own error table, and
Individual Freeze documentation states it explicitly *"prevents the counterparty from
withdrawing from AMMs containing those frozen tokens."* XRP itself can never be frozen
(no issuer), but once RLUSD is frozen on the multisig's trust line, the XRP bundled
inside that same LP position becomes inaccessible by association — there is no path out
(no transfer, no withdraw) until the freeze lifts. This applies to **all three** pools
(none has `NoFreeze` set), not just RLUSD — clawback is the catastrophic/permanent risk
unique to RLUSD; freeze is fully recoverable once lifted, but total (not partial) while
active, for all three. Sources: [XRPL AMM concepts](https://xrpl.org/docs/concepts/tokens/decentralized-exchange/automated-market-makers), [AMMWithdraw reference](https://xrpl.org/docs/references/protocol/transactions/types/ammwithdraw) (`tecFROZEN`), [Freezing Tokens](https://xrpl.org/docs/concepts/tokens/fungible-tokens/freezes).

**Conclusion:** XRP/USDC and XRP/ARMY carry no clawback risk (confirmed) and are safe to
proceed on that specific axis, though the freeze risk above still applies to them.
XRP/RLUSD carries both risks and should be held pending an explicit decision on whether
to accept clawback exposure on the most important pool in this list (see revised
priority below).

---

## Collateral Viability Assessment

### Tier 1 — Best candidates (high TVL, quality underlying assets)

#### 1. XRP/RLUSD ⭐⭐⭐ — ON HOLD pending clawback risk decision (see Issuer Risk Flags above)

> **2026-06-20 update:** RLUSD's issuer has `lsfAllowTrustLineClawback = TRUE`. Ripple
> can execute `AMMClawback` against the Axelar custodial multisig at any time, which
> would liquidate the multisig's entire pooled LP position — the sole backing for all
> wrapped XRP/RLUSD LP holders on XRPL EVM — leaving the wrapped supply partially or
> fully unbacked with no automatic adjustment. This was previously rated "TOP
> RECOMMENDATION"; do not list until this is explicitly accepted or mitigated.

| Parameter | Value |
|-----------|-------|
| Pool account | `rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3` |
| RLUSD issuer | `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` |
| TVL | **$5.26M** |
| 7d Volume | $635,790 |
| Fee | 0.267% |
| APY | 2.9% |
| XRP reserve | 1,893,541 XRP |
| RLUSD reserve | ~2,499,660 RLUSD |
| Impermanent loss risk | **VERY LOW** (XRP/USD stablecoin — both sides have USD price feeds) |

**Why it's the best collateral:**
- RLUSD is Ripple's regulated USD stablecoin — highest quality non-XRP asset on XRPL
- Near-zero IL: when XRP rises, pool rebalances to more RLUSD, still fully valued in USD
- Both assets have strong price feeds (XRP/USD spot + RLUSD = $1)
- LP token price formula uses geometric mean: `2 × sqrt(xrp × rlusd) / lp_supply` — manipulation resistant
- Sufficient TVL for $50K+ position liquidation without pool impact

**Suggested parameters:**
- Collateral Factor: **60%** (low IL = higher CF justified)
- Liquidation Threshold: **75%**
- Max position per borrower: **$52,600** (1% of TVL)
- Max total cap: **$526,000** (10% of TVL)

**LP oracle formula:**
```
xrp_reserve  = amm_info.amount (in drops) / 1e6
rlusd_reserve = amm_info.amount2.value
lp_supply    = amm_info.lp_token.value

LP_price_USD = 2 × sqrt(xrp_reserve × XRP_USD × rlusd_reserve × 1.00) / lp_supply
             = 2 × sqrt(xrp_reserve × 1.39 × rlusd_reserve) / lp_supply
```

#### 2. XRP/USDC ⭐⭐⭐ — STRONG CANDIDATE

| Parameter | Value |
|-----------|-------|
| Pool account | `rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE` |
| TVL | **$955,972** |
| 7d Volume | $128,879 |
| Fee | 0.202% |
| APY | 2.7% |
| IL risk | Low (XRP/USD stablecoin) |

No clawback risk — USDC issuer `lsfAllowTrustLineClawback = FALSE` (verified on-chain).
Residual freeze risk remains: USDC issuer has `lsfNoFreeze = FALSE`, and per the Issuer
Risk Flags section above, freezing USDC would also freeze the multisig's XRP/USDC LP
token, blocking redemption until lifted (recoverable, not catastrophic).

**Suggested parameters:**
- CF: **55%** | Liquidation threshold: **72%**
- Max position: **$9,560** (1% TVL) | Max cap: **$95,600** (10%)

#### 3. XRP/ARMY ⭐⭐ — VIABLE (largest non-stablecoin pair)

| Parameter | Value |
|-----------|-------|
| Pool account | `rnsRq5ahgbFeRiAgBVvFTafyAgiS9x9Ztn` |
| LP currency | `037C2A57B0011520DE389E332043EC0FAF858ACE` |
| TVL | **~$680,000** |
| Fee | 0.001% |
| IL risk | Moderate (ARMY token is volatile vs XRP) |

No clawback risk — ARMY issuer `lsfAllowTrustLineClawback = FALSE` (verified on-chain).
Residual freeze risk remains: ARMY issuer has `lsfNoFreeze = FALSE`, and per the Issuer
Risk Flags section above, freezing ARMY would also freeze the multisig's XRP/ARMY LP
token, blocking redemption until lifted (recoverable, not catastrophic).

**Suggested parameters:**
- CF: **40%** | Liquidation threshold: **60%**
- Max position: **$6,800** (1% TVL) | Max cap: **$68,000** (10%)

#### 4. XRP/USDT ⭐⭐ — VIABLE

| Parameter | Value |
|-----------|-------|
| Pool account | `rwDMCDG2s1qDxNwPTKSa1JFUgvLGJqvSwz` |
| TVL | **$216,574** |
| 7d Volume | $25,128 |
| Fee | 0.296% |
| APY | 12.3% |
| IL risk | Low (XRP/USD stablecoin) |

**Suggested parameters:**
- CF: **55%** | Liquidation threshold: **72%**
- Max position: **$2,166** | Max cap: **$21,657**

---

### Tier 2 — Watch list ($100K–$500K TVL, non-stablecoin second asset)

| Pool | TVL | 7d Vol | Assessment |
|------|-----|--------|------------|
| XRP/PHNIX | $820K | $289K | High volume/TVL ratio; PHNIX token needs research |
| XRP/FUZZY | $1.64M | $62K | Large TVL but FUZZY unknown — check token quality |
| XRP/XLM | $389K | $122K | Stellar (XLM) is reputable cross-chain asset; good volume |
| XRP/DROP | $280K | $56K | DROP token on XRPL — check issuance |
| XRP/CNY | $240K | $39K | Chinese Yuan IOU — regulated fiat representation |
| SHX/XRP | $223K | $19K | SHX (Stronghold USD/token) — check issuer |

**Action required for Tier 2:** research each token's issuer, total supply, and redemption model before listing.

---

### Tier 3 — High APY / speculative (not suitable as collateral now)

| Pool | TVL | 7d Vol | APY | Why not suitable |
|------|-----|--------|-----|-----------------|
| XRP/CFH | $24K | $193K | 77% | TVL too low, pump risk |
| XRP/GiB | $10K | $202K | 279% | TVL too low, speculative |
| OCTOPUS/XRP | $4.6K | $43K | 2468% | Clearly speculative, tiny TVL |
| XRP/X | $27K | $17K | 145% | Unknown token |
| AmericaFirst/XRP | $34K | $21K | 95% | Political meme token |

These pools generate high fee APY due to heavy speculative trading relative to small TVL — attractive for LPs, but collateral value is unstable.

---

## LP Token Price Oracle Design

### For XRP/Stablecoin pools (RLUSD, USDC, USDT)

```
LP_price_USD = 2 × sqrt(xrp_reserve_XRP × XRP_USD × stable_reserve × stable_USD) / lp_supply
```

Since stable_USD ≈ 1.00:
```
LP_price_USD = 2 × sqrt(xrp_reserve × XRP_USD × stable_reserve) / lp_supply
```

This formula (geometric mean of pool value) is manipulation-resistant because:
- To double the LP price artificially, an attacker must quadruple the XRP reserve
- That requires a massive one-sided buy that moves XRP price significantly

**For XRP/RLUSD today:**
```
xrp_reserve    = 1,893,541 XRP
rlusd_reserve  = 2,499,660 RLUSD
lp_supply      = [from amm_info]
XRP_USD        = $1.39

LP_price_USD = 2 × sqrt(1,893,541 × 1.39 × 2,499,660) / lp_supply
             = 2 × sqrt(6,585,455,640,540) / lp_supply
             = 2 × 2,566,410 / lp_supply
```

### For XRP/non-stablecoin pools (ARMY, PHNIX, etc.)

```
LP_price_XRP = 2 × xrp_reserve / lp_supply     [since 50/50 pool: xrp = 50% of value]
LP_price_USD = LP_price_XRP × XRP_USD
```

### TWAP recommendation

Query `amm_info` every ledger close (~1 second) and use a 20-ledger TWAP:
- Store last 20 XRP reserve readings
- Use median (not mean) to reject outliers from large single swaps
- Alert if reserve changes > 10% in one ledger (circuit breaker)

---

## Implementation Priority

| Priority | Pool | TVL | Action |
|----------|------|-----|--------|
| P0 | XRP/USDC | $956K | List with CF=55% — no clawback risk (verified on-chain) |
| P1 | XRP/ARMY | $680K | List with CF=40% after token research — no clawback risk (verified on-chain) |
| **Hold** | XRP/RLUSD | $5.26M | **Do not list until clawback risk is accepted/mitigated** — RLUSD issuer has `lsfAllowTrustLineClawback = TRUE`; AMMClawback against the Axelar custodial multisig could leave the entire wrapped LP supply unbacked. See "Issuer Risk Flags" section. |
| P3 | XRP/USDT | $217K | List with CF=55% |
| P4 | XRP/XLM | $389K | Research XLM issuer on XRPL first |
| Watch | XRP/FUZZY | $1.64M | Research FUZZY token — large TVL |
| Watch | XRP/PHNIX | $820K | High volume/TVL = active trading |

---

## Summary

| Metric | Value |
|--------|-------|
| Total AMM pools (all XRPL mainnet) | 184+ active |
| Pools with > $100K TVL | 14 |
| Pools with > $1M TVL | 3 (RLUSD, FUZZY, ARMY) |
| Largest pool | XRP/RLUSD — $5.26M |
| Best collateral candidate, clawback-clean | **XRP/USDC LP** |
| 2nd best, clawback-clean | **XRP/ARMY LP** |
| On hold pending clawback risk decision | **XRP/RLUSD LP** ($5.26M TVL, highest in this list) |
| Combined TVL of top 3 stablecoin pairs | ~$6.4M |
| Recommended XRP/RLUSD LP collateral factor (if/when unblocked) | **60%** |

**2026-06-20 update:** On-chain verification of issuer flags (see "Issuer Risk Flags"
section above) found that RLUSD's issuer has `lsfAllowTrustLineClawback = TRUE` —
`AMMClawback` is live on mainnet and could be used against the Axelar custodial
multisig holding the pooled XRP/RLUSD LP position, potentially leaving the entire
wrapped LP supply on XRPL EVM unbacked in a single transaction. XRP/RLUSD LP is no
longer the recommended immediate priority despite its TVL/IL/oracle advantages — it
should be held pending an explicit risk decision. **XRP/USDC LP and XRP/ARMY LP have no
clawback risk (confirmed on-chain) and are clear to proceed**, though both retain a
recoverable freeze risk (see Issuer Risk Flags section) shared by all three pools.
