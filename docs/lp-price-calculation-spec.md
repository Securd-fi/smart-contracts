# XRP/USDC LP Price — Calculation and Guard Specification

Written for: the dApp developer who runs the LP price bot. This specifies how the price is calculated off-chain, which guards must run before each post, and what the bot must do when a guard fails.

**Status (2026-10-06):**
- The borrow and mint pauses in §8 gate 2 are done. The three transactions are confirmed on-chain.
- The auditor has accepted the two definitions for the first post and the 1% deviation (§3, decisions below).
- **Owner decision (2026-10-06):** the protocol owner decided to use the fair formula `F` in §2, with the 25% haircut and the guards in §3. The owner stated this in chat. The developer asked for written approval, so the owner should also send it as a written message, or the owner's approval can be recorded in the repo by a signed commit.
- Still pending: G5, G6, and G8 must be implemented and tested in the bot. Do not post a price before the gates in §8 are met.

**Scope:** XRP/USDC LP token `0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53` (15 decimals), oracle `0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98`, pool on the XRPL Ledger `rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE`.

---

## 1. Inputs (read in the same tick)

| Symbol | Meaning | Source |
|---|---|---|
| `R_x` | XRP reserve of the AMM pool, in whole XRP | `amm_info` on the XRPL Ledger. XRP amounts are in drops: divide by 1,000,000. |
| `R_u` | USDC reserve of the AMM pool, in whole USDC | `amm_info`, the USDC.axl or Circle USDC IOU value as a decimal string. Use the same issuer as the pool. |
| `L` | total LP token supply, in whole LP tokens | `amm_info` `lp_token.value`. It is already a decimal string in whole LP tokens. Do not divide it by anything. The 15 decimals apply only to the EVM token, not to this XRPL value. |
| `P_x` | USD price of one whole XRP | Oracle flat price for XRP: 1e18 per whole token. Use the flat read, not `getUnderlyingPrice`. |
| `P_u` | USD price of one whole USDC | Oracle flat price for USDC, same convention. |
| `h` | haircut | 0.25 (2500 bps) |

**Units:** do all math in BigInt at 1e18 precision, rounding down. Do not use floating point for the posted value. The on-chain price is a flat USD value per whole LP token at 1e18 (`priceMantissa`).

**Decimals warning:** `getUnderlyingPrice` scales by the underlying's decimals. The bot must use the flat price. Using the scaled value would double-count the decimals and overvalue the collateral.

## 2. Formula

Let:
- `A = R_x × P_x` (USD value of the XRP side)
- `B = R_u × P_u` (USD value of the USDC side)
- `V = A + B` (pool value in USD)

**Current formula (sum-based, what the repo bot computes today):**

```
S = V / L
published = S × (1 − h)
```

**Proposed formula (fair value, pending owner approval):**

```
F = 2 × √(A × B) / L
published = F × (1 − h)
```

Why the proposed one: `V − 2√(AB) = (√A − √B)² ≥ 0`, so `F ≤ S` always. `F` depends only on the pool invariant, so trades that skew the reserves cannot raise it. `S` can be raised by skewing the pool.

**Approved formula (2026-10-06):** the protocol owner decided to use `F`, with the 25% haircut and the guards in §3. This was stated in chat. The owner's written approval line is still to come.

```
A = R_x × P_x
B = R_u × P_u
F = 2 × √(A × B) / L
published = F × (1 − 0.25)
```

**Worked example** (reserves from the 2026-10-05 snapshot, prices read on 2026-10-06: XRP $1.509199565, USDC $0.999800029, `L` = 13,782,369.43):
- `A` = $18,676.68, `B` = $18,516.74, imbalance 0.86%
- Sum formula: `S` = 0.00269862, published **0.00202397**
- Fair formula: `F` = 0.00269860, published **0.00202395**
- Gap: 0.0009%

These numbers show the formulas agree at this imbalance. They are not a target price. The live reserves and prices at posting time will differ.

## 3. Guards (run before every post, in this order)

Each guard either passes or stops the post for this tick. A stopped post is never clamped or adjusted.

| # | Guard | Rule | On failure |
|---|---|---|---|
| G1 | Input read | `amm_info`, both oracle prices, and `L` all read successfully. `R_x`, `R_u`, `L`, `P_x`, `P_u` are all greater than 0. | Skip, log, alert after 3 consecutive skips. |
| G2 | TVL floor | `V ≥ $25,000` (test waiver; the policy floor is $50,000 per docs/15 §8.3). | Skip. |
| G3 | Concentration | `A / V ≤ 85%` and `B / V ≤ 85%` (the config's `maxTokenWeightBps` = 8500). | Skip. |
| G4 | Reserve jump | Each reserve differs from its value in the 5-minute snapshot by at most 15%. | Skip. |
| G5 | First-post stability | Only for the first post after a restart or a gap, or the first post ever: (a) the bot has at least 300 seconds of history; (b) `\|published_now − published_snapshot\| / published_snapshot ≤ 1%`, where `published_snapshot` is the same formula applied to the snapshot inputs; (c) an operator has confirmed the first post by hand (a flag in the bot's state file, set once). | Skip. |
| G6 | Step bounds | Relative to the last **on-chain** posted price `P_last`: new price must be between `P_last × 0.90` and `P_last × 1.05`. | Skip. Do not clamp. |
| G7 | Deviation trigger | Post when `|published − P_last| / P_last ≥ 1%`, or when 120 seconds have passed since the last post. | Not a block. This decides whether to post. |
| G8 | Publisher gas | The publisher holds at least 0.05 XRP. | Skip and alert. |
| G9 | Post failure | If the transaction reverts or times out, keep `P_last` unchanged and retry on the next tick. | Retry. |

**Snapshot definition:** keep a rolling record of each tick's inputs. The snapshot for G4 and G5 is the most recent tick at least 300 seconds old.

**Decisions recorded (point 3, auditor review):**
- **First post:** allowed only when G1 to G4 and G8 pass, the bot has at least 300 seconds of history, the 1% agreement with the snapshot holds (G5b), and an operator has confirmed the first post by hand (G5c). The step bound G6 cannot apply, because no on-chain price exists yet.
- **1% deviation:** measured against the last on-chain posted price `P_last`. It is a trigger (G7), not the safety limit. The safety limit is the step bound G6: no post above +5% or below −10% of `P_last`. If both apply, the tighter limit wins.

**Freshness:** the oracle marks a price stale after 900 seconds. The bot must post at least every 120 seconds (G7), so a price is never close to going stale. Alert if no successful post happens for 10 minutes.

## 4. What the repo bot enforces today

Checked against `scripts/runXrplLpOracleBot.ts` in the repo. Your Vercel version may differ, so please confirm each line.

| Guard | Implemented in the repo bot? | Detail |
|---|---|---|
| G1 input read | Partly | Reads succeed or the tick throws. There is no explicit zero check. |
| G2 TVL floor | Yes | Checked against `minTvlUsd`. |
| G3 concentration | Yes | Checked against `maxTokenWeightBps`. |
| G4 reserve jump | Partly | Compares against the **previous tick** (about 15 seconds), not the 5-minute snapshot. |
| G5 first-post stability | **No** | Not implemented. |
| G6 step bounds (+5% / −10%) | **No** | `maxStepUpBps` and `maxStepDownBps` are read by the config validator but not used. |
| G7 deviation trigger | Yes | `shouldPublish` uses `minDeviationBps` and `publishIntervalSec`. |
| G8 publisher gas | **No** | Not implemented. |
| G9 post failure | Partly | Errors are logged; the state is updated on the next tick. |
| Max price age (`maxPriceAgeSec` = 180) | **No** | Read by the config validator but not used. |

**Action needed:** bring the Vercel code in line with §3, or confirm in writing that it already does. Until G5, G6, and G8 are in place, the bot must not post.

## 5. Posting

- Call `postFallbackPrice(0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53, published)` on the oracle `0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98`.
- The contract rejects a zero price and any caller that is not an authorised oracle. It does not check the value, the reserves, or any step limit. Every check in §3 is the bot's responsibility.
- Record the transaction hash and the inputs used (`R_x`, `R_u`, `L`, `P_x`, `P_u`, `A`, `B`, `V`, the formula used, and the published value) in the bot's log.

## 6. Parameters

| Parameter | Value | Source |
|---|---|---|
| Haircut `h` | 25% (2500 bps) | config `risk.haircutBps` |
| TVL floor | $25,000 (test waiver) | config `risk.minTvlUsd` |
| Concentration cap | 85% (8500 bps) | config `risk.maxTokenWeightBps` |
| Reserve jump | 15% (1500 bps) vs 5-minute snapshot | config `defaults.maxReserveJumpBps` (window to be changed to the snapshot) |
| Step up / down | +5% / −10% | config `defaults.maxStepUpBps` (500), `maxStepDownBps` (1000) |
| Deviation trigger | 1% (100 bps) | config `defaults.minDeviationBps` |
| Publish interval | 120 seconds | config `defaults.publishIntervalSec` |
| Publisher XRP minimum | 0.05 XRP | this spec |
| On-chain staleness | 900 seconds | oracle `fallbackMaxDelay` |

## 7. Not on-chain

Everything in §1 to §3 runs off-chain. The oracle does not verify the reserves, the formula, or any guard. Anyone with the bot key can post any non-zero value. The protection is the bot's code and the monitoring around it. This is a known limitation and is recorded for the audit.

## 8. Gates before the first post

1. The protocol owner approves the formula choice (§2) in writing.
2. **Done, 2026-10-06.** Pause guardian transactions, each confirmed on-chain:
   - `_setBorrowPaused(sXRPUSDCLP, true)`: [0x47e45abc…6f48](https://explorer.xrplevm.org/tx/0x47e45abcbb2ad5d4cb08030c48cd92f3badb8966177c7d4cd78a88ed2fa76f48), block 8011931
   - `_setBorrowPaused(sXRPARMYLP, true)`: [0xdf19b396…bf45](https://explorer.xrplevm.org/tx/0xdf19b39680d3abba71b923fc836feed54a2d76bc24862fa1546bae1a222ebf45), block 8011932
   - `_setMintPaused(sXRPARMYLP, true)`: [0xcccc4a86…39e5](https://explorer.xrplevm.org/tx/0xcccc4a863732e3fa92b132394761a5154dec17d9b4ec0492191a6c7db4ec39e5), block 8011933

   The LP mint is not paused. That is intentional: the test deposit is already in place.
3. G5, G6, and G8 are implemented and tested. For G5, the operator's manual confirmation of the first post is part of this gate.
4. The config is switched to an HTTP RPC (`https://s1.ripple.com` or the equivalent), because the script calls `amm_info` over HTTP.

## 9. Access model (decided 2026-10-06)

- **Visibility:** open to all XRPL accounts. The dApp shows the LP market with the test banner on every LP screen.
- **LP collateral actions:** supply and enter-market stay off in the dApp until (a) the collateral factor reads 0.35e18 and (b) G5, G6 and G8 are live in the bot.
- **Borrow caps (set by the borrow cap guardian before 2026-10-07 11:34 UTC):**
  - sUSDC `0x21Da09A16d69757C0731De3b83e65061BCF30E00`: 2,000 USDC, raw `2000000000`
  - sXRP `0xEFedd95eFdB71652bd93F58b2B7F77748Dee04F6`: 1,000 XRP, raw `1000000000000000000000`
- **Review:** raise either cap only after the guards are live and the first week of posts has been checked.
