# Securd LP Leverage, Deleverage, and Delta-Neutral Strategy — Technical Specification & Design Audit

**Network scope: XRPL Ledger MAINNET + XRP Ledger native DEX/AMM (mainnet pools) +
Securd on XRPL EVM MAINNET (chain 1440000).** Every identifier in this document is a
real, verified mainnet address — not a testnet or placeholder value. The user-facing
side of every transaction in this spec is submitted on **XRPL Ledger mainnet**; Securd
itself, and the lending markets being borrowed against, run on XRPL EVM mainnet, reached
only through the Axelar mainnet gateway and the XRPL native AMM described below.

**DEX used:** XRPL native AMM (XRPL Ledger mainnet), via `AMMDeposit` / `AMMWithdraw` —
no other DEX, aggregator, or EVM-side swap is used anywhere in this design.

**Status:** Design specification — no contract changes implied or required. Everything
described here is built from primitives that already exist in Securd
(`XRPLSecurdBridgeAdapter`, `Comptroller`, `CErc20`) plus standard XRPL Ledger AMM
transactions. This document does not require new Solidity. Securd's own mainnet
deployment does not exist yet (per
[xrpl-lp-token-bridge-readiness-verification.md](xrpl-lp-token-bridge-readiness-verification.md));
the Securd-side addresses below are placeholders to fill in once it does. Every
XRPL-Ledger-side and Axelar-side identifier is already live today.

### 0.1 Mainnet identifiers used throughout this spec

| Role | Identifier |
|---|---|
| Axelar XRPL mainnet gateway (custody account, all egress/ingress destinations) | `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` |
| Axelar destination-chain string for XRPL EVM | `xrpl-evm` |
| XRP/USDC AMM pool account (= LP token issuer) | `rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE` |
| XRP/USDC LP currency code | `03B20F3A7D26D33C6DA3503E5CCE3E67B102D4D2` |
| USDC issuer (XRPL mainnet) | `rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE` |
| XRP/USDC wrapped LP token, XRPL EVM mainnet | `0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53` |
| XRP/USDC LP ITS `tokenId` | `0xe2f2d147cc5da2f15c947b85d9a0bd88dc7e64bf864725a76b064002a06e291b` |
| XRP/ARMY AMM pool account (= LP token issuer) | `rnsRq5ahgbFeRiAgBVvFTafyAgiS9x9Ztn` |
| XRP/ARMY LP currency code | `037C2A57B0011520DE389E332043EC0FAF858ACE` |
| ARMY issuer (XRPL mainnet) | `rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC` |
| XRP/ARMY wrapped LP token, XRPL EVM mainnet | `0xD66b43e8a145e3b9e2d7e0F12f28255CB647Db7e` |
| XRP/ARMY LP ITS `tokenId` | `0x1531fd6c4c214c74ed2c93c7692c39e109eaf0e6057d26c19b2f24e542294a23` |
| XRPL EVM mainnet chain ID | `1440000` |
| Securd `XRPLSecurdBridgeAdapter` (mainnet) | **not deployed yet — TBD** |
| Securd cToken markets for the two LP tokens (mainnet) | **not deployed yet — TBD** |

All XRPL Ledger transactions below (`Payment`-with-memo for SUPPLY/REPAY, the GMP
`Payment`-with-memo for BORROW/WITHDRAW/ENTER_MARKET/EXIT_MARKET, the Add Gas
`Payment`, `AMMDeposit`, `AMMWithdraw`, and any `OfferCreate`) are submitted by the
user's own XRPL mainnet account directly against `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`
(for bridge legs) or directly against the AMM pool accounts above (for `AMMDeposit`/
`AMMWithdraw`) — there is no testnet network, RPC, or gateway address anywhere in this
design.

---

## 1. The one fact that shapes this entire design

**The AMM lives on XRPL Ledger. Securd's lending markets live on XRPL EVM. There is no
atomic call path between them.**

Axelar GMP/ITS only carries two things across the bridge: token value (ITS) and a
signed control intent (GMP `call_contract`). There is no mechanism for an XRPL EVM
contract to remotely trigger an `AMMDeposit` or `AMMWithdraw` transaction on XRPL
Ledger — those are native XRPL transaction types that only the XRPL account itself (or
something holding its keys) can submit.

Consequence: **"leveraging an LP position" cannot be a single atomic transaction**, the
way it would be on a single EVM chain where a vault contract borrows, swaps, and adds
liquidity inside one flash-loan-style call. Here, every leverage "turn" is a sequence of
at least 3 separate transactions across two ledgers, each with its own confirmation
latency (Axelar relay time observed in this project's own testing: low minutes, not
seconds — see [xrpl-stst-add-gas-flow-testnet-transactions.md](xrpl-stst-add-gas-flow-testnet-transactions.md)).
This drives almost every risk finding in §7.

---

## 2. Notation

| Symbol | Meaning |
|---|---|
| `x` | XRP reserve in the pool |
| `y` | other-asset reserve in the pool (USDC or ARMY) |
| `k` | constant-product invariant, `x·y = k` |
| `P` | price of XRP in terms of the other asset (`P = y/x` marginally) |
| `f` | user's LP ownership fraction = `userLPBalance / LP_totalSupply` |
| `CF` | Securd collateral factor for the LP token market |
| `E0` | user's starting equity (value of their initial LP position) |

---

## 3. Leverage — the looped LP position

### 3.1 Concept

The user already holds (or newly supplies) an LP token as Securd collateral. Each
"loop" borrows more of the pool's two underlying assets against that collateral,
deposits them back into the *same* XRPL AMM pool to mint *more* LP tokens, and
re-supplies those as additional collateral — increasing both collateral and debt each
turn, the same recursive-loop pattern used for leveraged staking/lending on single-chain
protocols, just spread across two ledgers per turn instead of one atomic call.

### 3.2 Transaction sequence — one loop turn

Precondition: user's LP collateral is already supplied and the proxy has called
`ENTER_MARKET` once (one-time, not repeated per loop).

| # | Where | Transaction | What it does |
|---|---|---|---|
| 1 | XRPL mainnet `Payment` → gateway `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` (memo `type=call_contract`) | `BORROW` signed intent, `amount = ΔXRP` | Adapter calls `proxy.execute(cXRP, borrow(ΔXRP))`, then ITS-egresses `ΔXRP` back to the user's XRPL mainnet wallet |
| 2 | Same gateway, separate `Payment` | `BORROW` signed intent, `amount = Δstable` (USDC or ARMY) | Same as above, for the second pool asset; **separate intent, next nonce** — the adapter processes one action type per intent |
| 3 | XRPL mainnet, direct to the pool account | `AMMDeposit` — `Asset`=XRP, `Asset2`=stable, flag `tfTwoAsset`, `Amount=ΔXRP`, `Amount2=Δstable` | Mints new LP tokens directly into the user's XRPL mainnet wallet. If the live pool ratio has drifted since `ΔXRP`/`Δstable` were computed, the ledger **silently deposits less than specified** rather than reverting (safe degradation — see §7.3), only failing with `tecAMM_FAILED` in extreme cases |
| 4 | XRPL mainnet `Payment` → gateway `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` (memo `type=interchain_transfer`) | `SUPPLY` signed intent carrying the newly-minted LP tokens | Adapter mints additional cLP into the proxy, increasing collateral |

Step 3's exact transaction, worked for the XRP/USDC pool on mainnet:
```
TransactionType: AMMDeposit
Account:  <user XRPL mainnet address>
Asset:    { currency: "XRP" }
Asset2:   { currency: "5553444300000000000000000000000000000000",
            issuer: "rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE" }
Amount:   "<ΔXRP, drops>"
Amount2:  { currency: "5553444300000000000000000000000000000000",
            issuer: "rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE",
            value: "<Δstable>" }
Flags:    tfTwoAsset   (0x00100000)
```
For the XRP/ARMY pool, swap `Asset2`/`Amount2` to
`{ currency: "41524D5900000000000000000000000000000000", issuer: "rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC" }`
— everything else is identical.
Recompute `ΔXRP`/`Δstable` from a fresh `amm_info` call as close to submission as
possible — the narrower the gap between reading the ratio and submitting, the less
value goes undeployed by the auto-downward-adjustment behavior.

Step 4 needs the **same gas-payment treatment validated earlier in this project for
STST**: LP tokens almost certainly have no Axelar in-kind gas price configured, so the
`interchain_transfer` memo must carry `gas_fee_amount = "0"` and a separate native-XRP
`add_gas` Payment to the gateway, referencing this transfer's hash as `msg_id` — exactly
the pattern in [submitXrplStsTSupplyAddGas.ts](../scripts/submitXrplStsTSupplyAddGas.ts).
Do not assume the simpler in-kind-gas SUPPLY path works for LP tokens without verifying
it first, the same way it had to be verified for STST.

### 3.3 Why this converges to a maximum leverage, and what that maximum is

Each loop turn supplies new collateral that can only be borrowed against up to the
collateral factor `CF` of the LP token market — not the collateral factor of whatever
you borrowed (borrowing capacity is gated entirely by the *collateral* side of
`getAccountLiquidity`, regardless of which market the debt is drawn from). Treat the
loop as depositing value rather than tracking XRP and stablecoin separately — the
`AMMDeposit` converts borrowed value into LP value at (approximately) 1:1, net of the
pool's own trading fee on the deposit, which is small.

**Per-turn geometric series.** Starting equity `E0`:

```
Collateral after N loops = E0 × (1 + CF + CF² + ... + CF^N) = E0 × (1 − CF^(N+1)) / (1 − CF)
Debt after N loops        = Collateral after N loops − E0
Leverage after N loops     = Collateral / E0 = (1 − CF^(N+1)) / (1 − CF)
```

As `N → ∞`:

```
L_max = 1 / (1 − CF)
```

This is the same formula as any recursive lending loop (Aave-style stETH looping,
cToken-style looping) — the cross-chain mechanics change *how* you get there,
not the ceiling itself.

**Concrete numbers, using Securd's already-defined collateral factors:**

| Pool | CF | `L_max = 1/(1−CF)` |
|---|---:|---:|
| XRP/USDC LP | 57% | **2.33×** |
| XRP/ARMY LP | 35% | **1.54×** |

**Convergence table** (leverage achieved after N loops):

| N | XRP/USDC LP (CF=57%) | XRP/ARMY LP (CF=35%) |
|---:|---:|---:|
| 1 | 1.570× | 1.350× |
| 2 | 1.895× | 1.473× |
| 3 | 2.080× | 1.515× |
| 4 | 2.186× | 1.530× |
| 5 | 2.246× | 1.535× |
| 6 | 2.280× | 1.537× |
| ∞ | 2.326× | 1.538× |

Diminishing returns set in fast: loop 4–5 already captures ~95%+ of theoretical max
leverage for both pools. There is rarely a reason to loop more than 4–5 times.

### 3.4 Per-loop cost — leverage is not free here

Each loop incurs, at minimum: one GMP relay gas payment per `BORROW` intent (~3 XRP
each, per `XRPL_GMP_GAS_DROPS` defaults already used elsewhere in this repo), one ITS
egress gas cost per borrowed asset (~1 XRP per `egressGasValue`), one XRPL Ledger
`AMMDeposit` transaction fee (negligible, ~12 drops), and one `SUPPLY`-leg Add-Gas pair
(transfer + ~2 XRP add-gas, per the validated STST pattern). Rough order of magnitude:
**5–10 XRP of pure relay/gas overhead per loop**, before any AMM trading fee on the
deposit itself. For a $5,000 position this is noise; for a $200 position run through 4
loops, the overhead alone can be a meaningful fraction of expected yield. **Set a
minimum position size before recommending looping** — see §10.

---

## 4. Deleverage — unwinding the loop

The exact reverse, asset-by-asset:

| # | Where | Transaction | What it does |
|---|---|---|---|
| 1 | XRPL mainnet `Payment` → gateway `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` (memo `type=call_contract`) | `WITHDRAW` signed intent for `amount` of LP collateral | Adapter calls `proxy.execute(cLP, redeemUnderlying(amount))` — **Comptroller's existing `redeemAllowed` check already prevents withdrawing more than current excess liquidity allows**, so this step is self-limiting and cannot be used to under-collateralize the position — then ITS-egresses the LP token back to the user's XRPL mainnet wallet (likely needs the same `gas_fee_amount=0` + Add Gas treatment as SUPPLY) |
| 2 | XRPL mainnet, direct to the pool account | `AMMWithdraw` — `Asset`=XRP, `Asset2`=stable, flag `tfLPToken`, `LPTokenIn=amount` | Burns the LP token, returns XRP + stable proportionally to the user's XRPL mainnet wallet — clean, no ratio guesswork needed |
| 3 | XRPL mainnet `Payment` → gateway `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` (memo `type=interchain_transfer`) | `REPAY` signed intent(s), one per asset received | Reduces XRP debt and/or stable debt |

Step 2's exact transaction, worked for the XRP/USDC pool on mainnet:
```
TransactionType: AMMWithdraw
Account: <user XRPL mainnet address>
Asset:   { currency: "XRP" }
Asset2:  { currency: "5553444300000000000000000000000000000000",
           issuer: "rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE" }
LPTokenIn: { currency: "03B20F3A7D26D33C6DA3503E5CCE3E67B102D4D2",
             issuer: "rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE",
             value: "<amount>" }
Flags:   tfLPToken   (0x00010000)
```
For the XRP/ARMY pool: `Asset2` = `{ currency: "41524D5900000000000000000000000000000000", issuer: "rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC" }`,
`LPTokenIn` = `{ currency: "037C2A57B0011520DE389E332043EC0FAF858ACE", issuer: "rnsRq5ahgbFeRiAgBVvFTafyAgiS9x9Ztn", value: "<amount>" }`.

**Sequencing guidance:** because step 1 is already gated by the Comptroller's own
liquidity check, the natural unwind loop is: withdraw the largest safe amount of LP
collateral the protocol currently allows → `AMMWithdraw` → `REPAY` both assets → this
frees more withdrawable headroom → repeat.

**Final repay must underpay slightly, never overpay — verified against the contract,
not assumed.** `CToken.repayBorrowFresh` computes `accountBorrowsNew = accountBorrowsPrev
- actualRepayAmount` using plain Solidity 0.8 checked arithmetic: if the repaid amount
exceeds the debt at execution time, this reverts the *entire* transaction, it does not
refund the excess. the usual escape hatch — passing `type(uint256).max` to mean
"repay everything" — is unreachable through this bridge: `executeWithInterchainToken`
requires `envelope.amount` to exactly equal the ITS-delivered token amount, and you
cannot ITS-deliver `2²⁵⁶−1` tokens. So: size the final `REPAY` intent to slightly
*underpay* the debt read at intent-construction time (e.g. 99.9% of current
`borrowBalanceCurrent`), accepting a small intentional dust debt, rather than risking a
revert from interest accrued during the multi-minute relay window pushing your "exact"
amount into overpay territory by execution time. See §7.10 for the full mechanism and
consequence if this is gotten wrong.

---

## 5. Delta-neutral LP strategy

### 5.1 Why an LP position has directional exposure at all

For a constant-product pool (`x·y = k`, price `P = y/x`), the pool's total value
expressed in the stable asset is:

```
V_pool(P) = x·P + y = √(k/P)·P + √(k·P) = 2·√(k·P)
```

A user owning fraction `f` of the pool has position value `V(P) = 2f√(k)·√P`. Taking
the derivative:

```
dV/dP = f·√(k/P) = f·x
```

**This is the key result: the LP position's first-order sensitivity to the XRP price
is exactly equal to the XRP quantity it currently holds (`f·x`) — identical to simply
holding that much XRP outright.** The *only* difference between an LP position and
holding `f·x` XRP + `f·y` stable directly is the second-order (convexity / gamma) term,
which is exactly impermanent loss. Delta-hedging removes the first-order term and
leaves the LP holder with: AMM trading fees, minus the cost of carrying the hedge, minus
residual (unhedged) convexity loss.

### 5.2 Hedge construction

1. Supply the LP token as Securd collateral, `ENTER_MARKET` once.
2. Compute the current hedge target: `x_share = f × x`, where `f` and `x` are read live
   from `amm_info` against the relevant mainnet pool account (`rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE`
   for XRP/USDC, `rnsRq5ahgbFeRiAgBVvFTafyAgiS9x9Ztn` for XRP/ARMY) — `f` from LP token
   balance vs. `lp_token.value`, `x` from the pool's `amount` field.
3. `BORROW` `x_share` XRP from Securd against the LP collateral (signed intent through
   `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`, egresses to the user's XRPL mainnet wallet,
   same as any BORROW).
4. On XRPL Ledger mainnet, **sell the borrowed XRP** for the stable asset on the native
   DEX (an `OfferCreate` against the same pool's currency pair, or a single-sided AMM
   swap through the pool account above) — this is what actually locks in the short.
   Simply holding the borrowed XRP without selling it creates no hedge at all (the
   asset and the debt would just cancel trivially, doing nothing useful).
5. Net result: LP position (long `f·x` XRP delta) + XRP debt (short `x_share` XRP
   delta) ≈ **flat net XRP exposure**, while still earning AMM fees on the LP.

### 5.3 Rebalancing — this is not "set and forget"

`x_share = f·x` is a function of price (since `x = √(k/P)` shrinks as `P` rises). As
price moves, the correct hedge size drifts continuously — this is the LP position's
gamma. A static hedge decays in accuracy as soon as price moves at all.

**Rebalance trigger** (either works, pick one for the keeper bot):
- **Price-drift trigger:** recompute `x_share` whenever XRP price moves more than a
  threshold (e.g. 2–3%) since the last rebalance.
- **Time trigger:** recompute on a fixed interval (e.g. every N XRPL ledgers or every
  hour), accepting some residual gamma between rebalances.

**Rebalance actions:**
- If new `x_share` > current XRP debt → `BORROW` the difference, sell it for stable.
- If new `x_share` < current XRP debt → buy back XRP with stable on the XRPL DEX,
  `REPAY` the difference.

Each rebalance is itself a 2–3 transaction round trip (BORROW/REPAY intent + DEX
trade), with the same relay-latency and gas considerations as §3.4 — rebalancing too
aggressively burns the strategy's edge in fees; rebalancing too rarely leaves it
under-hedged. This is the central tuning parameter of the whole strategy.

### 5.4 Unwind

Buy back enough XRP on the XRPL DEX to fully cover the outstanding XRP debt, `REPAY`,
then withdraw the LP collateral via the deleverage flow in §4 (or leave it supplied,
un-hedged, if simply ending the hedge rather than the whole position).

---

## 6. Full transaction catalogue

| Action | Leg | Transaction type | Notes |
|---|---|---|---|
| Initial supply | EVM-bound | `SUPPLY` (ITS, signed intent) | one-time per new LP deposit |
| Enable as collateral | EVM-bound | `ENTER_MARKET` (GMP, signed intent) | one-time |
| Leverage: borrow leg | EVM-bound | `BORROW` ×2 (GMP, signed intent) | one per pool asset, per loop |
| Leverage: pool deposit | XRPL-native | `AMMDeposit`, `tfTwoAsset` | per loop |
| Leverage: re-supply LP | EVM-bound | `SUPPLY` (ITS) + Add Gas pair | per loop |
| Deleverage: withdraw leg | EVM-bound | `WITHDRAW` (GMP, signed intent) | per loop |
| Deleverage: pool exit | XRPL-native | `AMMWithdraw`, `tfLPToken` | per loop |
| Deleverage: repay leg | EVM-bound | `REPAY` ×2 (ITS) + Add Gas pair | per loop |
| Hedge: borrow XRP | EVM-bound | `BORROW` (GMP) | per rebalance, when increasing short |
| Hedge: sell/buy XRP | XRPL-native | `OfferCreate` or AMM swap | every rebalance |
| Hedge: repay XRP | EVM-bound | `REPAY` (ITS) + Add Gas pair | per rebalance, when reducing short |
| Disable collateral | EVM-bound | `EXIT_MARKET` (GMP, signed intent) | one-time, on full exit |

---

## 7. Design audit — risk findings

### 7.1 Non-atomic execution window (the central risk)

Between step 1 (borrow, debt recorded on Securd) and step 4 (new LP re-supplied,
collateral increased), the position is in a transiently worse state than either before
or after the loop: debt is already up, collateral isn't yet. The Comptroller's
liquidity check at borrow time only sees *current* collateral, so a loop's borrow size
is naturally self-limiting and cannot push the account itself into shortfall at the
moment of borrowing — but if the XRP price drops sharply during the multi-minute
window while funds are in transit (sitting as raw, not-yet-redeposited XRP/stable on
XRPL Ledger), the account is more exposed to a price move during that window than a
single-block atomic loop would ever be. **This risk scales with the number of
loops/rebalances in flight and with Axelar relay latency**, which this project's own
testing showed running to several minutes per leg, not seconds.

### 7.2 Oracle staleness compounds with looping speed

LP token pricing is `FALLBACK`-mode (bot-posted, per Securd's oracle architecture) —
looping multiple times in quick succession increases the chance that a loop executes
against a stale LP price (too high) right before a real price correction, letting a
user over-borrow against a valuation that's about to drop. Recommend: gate `BORROW`
sizing in any looping tool against the oracle's reported last-update timestamp, not
just the raw price.

### 7.3 `AMMDeposit` ratio mismatch fails safe, not silent-loss

Confirmed from the XRPL spec: a `tfTwoAsset` deposit auto-adjusts *downward* if the
specified amounts don't match the live pool ratio — it does not lose funds or revert
in the common case (only `tecAMM_FAILED` in extreme cases). The practical effect is
some borrowed value can go undeployed (sits idle in the wallet as plain XRP/stable
instead of becoming LP collateral) rather than being lost — worth surfacing in any UI
built on this ("you may receive less LP than expected this loop") rather than treating
it as a failure mode.

### 7.4 Nonce sequencing can deadlock a multi-loop sequence

Securd's nonce model is strict and sequential per `xrplAccount` — every intent must
execute in exact order, and a stuck or underfunded leg (e.g., an ITS transfer that
needed the Add-Gas top-up discovered earlier in this engagement but didn't get one)
blocks every subsequent intent for that account until resolved, with `resetNonce` as
the only owner-controlled escape hatch. **A multi-loop leverage sequence is exactly the
scenario most likely to hit this**: more intents in flight, more chances for one leg to
need manual gas remediation. Any orchestration tooling built for this strategy needs to
budget Add-Gas pre-emptively for every ITS leg (LP token SUPPLY/REPAY), not just retry
reactively after a stuck transfer is noticed.

### 7.5 Liquidation mechanics for LP collateral are harder than for single assets

Liquidating an LP-collateral position requires the liquidator to eventually unwind
`cLP` → LP token → `AMMWithdraw` → sell, which needs XRPL Ledger execution capability on
top of the existing EVM-side `SecurdLiquidationKeeper` flow. A leveraged LP position
liquidates the same way as an unleveraged one from the Comptroller's point of view, but
the keeper/liquidator tooling needs the extra XRPL-side step to actually realize value
from seized LP collateral — worth confirming the keeper bot's operational runbook
covers this before leverage is offered to users.

### 7.6 Leverage and delta-hedging compete for the same liquidity budget

Both the leverage loop (§3) and the delta-hedge (§5) borrow against the *same*
`getAccountLiquidity` headroom from the *same* LP collateral. A user (or a combined
"leveraged delta-neutral" product) must budget collateral capacity across both purposes
explicitly — using the full `L_max` for leverage leaves nothing to also borrow the XRP
hedge, and vice versa. Any orchestration tool should expose this as one combined
capacity check, not two independent ones.

### 7.7 Borrow caps are a systemic ceiling, not just a per-user one

Securd's `XRP` and stablecoin markets have protocol-level `Borrow Cap`s
(`securd-asset-listing-risk-parameters.md`). If looping/hedging becomes popular, many
users drawing on the same borrowable markets simultaneously can hit the cap and block
further loops/rebalances for everyone, independent of any single user's own collateral
headroom. This is worth monitoring as a launch-readiness metric once LP markets go
live, not just at the individual-position level.

### 7.8 Audit addendum — signature burden is a real UX constraint, not just a detail

Each leg in §6 is a separate XRPL transaction requiring a separate signature. A 4-loop
leverage sequence is `2 BORROW + 1 AMMDeposit + 1 SUPPLY + 1 Add-Gas` per loop = **5
signatures × 4 loops = 20 signatures**, plus the one-time `ENTER_MARKET`. A human
manually approving 20 wallet prompts in sequence, each waiting on a multi-minute Axelar
relay before the next becomes valid (wrong nonce otherwise — §7.4), is not a workable
end-user flow. This has to be either fully automated (a delegated signer / session key
the user authorizes once, consistent with how `intentSignerOfXrplAccount` already
separates the bridge-intent signer from the XRPL transaction signer) or batched into far
fewer user-visible approvals than the raw transaction count suggests. This is as much a
product decision as an engineering one and should be resolved before exposing looping
in the dApp, not discovered after.

### 7.9 Audit addendum — undeployed loop capital needs an explicit resting state

§7.3 established that a ratio-mismatched `AMMDeposit` leaves leftover XRP/stable sitting
in the user's plain XRPL wallet rather than becoming LP collateral. This spec doesn't
yet define what happens to that leftover: it is *not* automatically swept back into
Securd as debt repayment or additional single-asset collateral, and it is *not*
protected by anything — it just sits as a plain wallet balance, fully exposed to price
risk and to ordinary key-custody risk, while Securd's books still show it as an
outstanding, unmatched-collateral debt. The dApp needs to either (a) detect this
leftover after every loop and prompt the user to act on it (repay, sweep into the next
loop, or hold), or (b) size loop amounts conservatively enough up front that leftovers
stay below a dust threshold. Leaving this undefined is itself a finding, not just a
UX nicety.

### 7.10 Final-audit finding — overpaying `REPAY` reverts the whole cross-chain execution

Verified directly against [CToken.sol](../contracts/core/CToken.sol) (`repayBorrowFresh`):
debt is reduced via plain Solidity 0.8 subtraction
(`accountBorrowsNew = accountBorrowsPrev - actualRepayAmount`), which reverts on
underflow if the repaid amount exceeds the debt at the moment of execution — it does
**not** cap the repayment and refund the excess, contrary to the original (incorrect)
guidance this spec gave in an earlier draft of §4. the normal
`type(uint256).max` "repay all" sentinel is unreachable through this bridge specifically,
because `XRPLSecurdBridgeAdapter.executeWithInterchainToken` enforces
`envelope.amount == amount` against the literal ITS-delivered token quantity — there is
no way to signal "repay everything" without knowing the exact figure in advance.

**Consequence if this is gotten wrong:** because `_repay()` runs inside the same atomic
`executeWithInterchainToken` call that the ITS executor uses to deliver the bridged
tokens, a revert here reverts the whole execution — the underlying tokens are not lost
(they remain locked on the XRPL Ledger side under Axelar's lock/unlock custody), but the
message is left in a failed-execution state requiring manual retry through Axelar's
recovery tooling, the same operational category as the nonce-deadlock risk in §7.4, not
a fund-safety issue. Still: a deleverage/repay tool that doesn't account for interest
accrual during the relay window will intermittently fail its final repay, and the fix
(underpay slightly, accept dust) is now stated correctly in §4.

---

## 8. dApp monitoring & observability specification

Every risk in §7 maps to something the dApp must actively watch and surface — this
section is the concrete monitoring spec, not just narrative risk description. Each item
states what to track, where the data comes from, and what UI/alert behavior it drives.

### 8.1 Position health (poll continuously, e.g. every block/ledger close)

| Metric | Source | UI behavior |
|---|---|---|
| Health Factor (HF) | `Comptroller.getAccountLiquidity(proxy)` (XRPL EVM) | Always visible; color-coded; red below a configurable warning band (e.g. HF < 1.15) |
| Current leverage ratio | `(total collateral value) / (collateral value − debt value)`, both from `getAccountLiquidity` + oracle reads | Shown next to HF; compared against the user's chosen target from §3.3 |
| Collateral / debt breakdown by asset | `CToken.balanceOf` + `borrowBalanceStored` per market, for the proxy | Itemized list, not just a single number — user needs to see XRP debt vs. stable debt separately |
| Distance to liquidation | Derived from HF and the asset's `Liquidation Incentive`/close factor (`securd-asset-listing-risk-parameters.md`) | Explicit "% price drop to liquidation" figure, not just raw HF |

### 8.2 In-flight transaction state (the §7.1/§7.8 non-atomicity risk, made visible)

| State | Source | UI behavior |
|---|---|---|
| Current step of an active loop (e.g. "2/5: waiting for Axelar relay") | Local session state + last known signed `intentId` | Persistent banner while a loop/rebalance is mid-sequence; survives page reload (must be stored, not just in-memory) |
| Per-leg Axelar relay status | Axelar GMP API `searchGMP` by `txHash`/`messageId` (as used directly in this engagement's own testing — see [xrpl-stst-add-gas-flow-testnet-transactions.md](xrpl-stst-add-gas-flow-testnet-transactions.md)) | Show `approved` / `executed` / stuck per leg; don't let the user start the next leg's signature until the previous one shows `executed` on the EVM side, not just `executed` at the Axelar-hub hop (the two are different — confirmed by direct testing earlier in this engagement) |
| Stuck-nonce detection | `nextNonceByXrplAccount(xrplAccount)` vs. the nonce the dApp expects to be current | If they diverge and no pending leg explains it, surface "this account's intent queue is stuck" rather than silently retrying — §7.4 |
| Missing Add-Gas detection | Axelar GMP `is_insufficient_fee` field on the relevant `searchGMP` record | If `true` past a grace period, prompt the user to submit the Add Gas top-up immediately, with the exact `msg_id` pre-filled |
| Undeployed leftover capital after a loop (§7.9) | Compare wallet's plain XRP/stable balance before vs. after the `AMMDeposit` leg | If nonzero past a dust threshold, prompt the user to act on it explicitly — do not leave it silently unresolved |

### 8.3 Oracle freshness (gates whether looping/rebalancing should even be offered)

| Metric | Source | UI behavior |
|---|---|---|
| LP token price last-update timestamp | `SecurdPriceOracle` fallback-mode storage for the LP asset | Show staleness explicitly ("price as of Xs ago"); disable new `BORROW`/loop actions past the protocol's configured freshness window (`03-security-model.md`), not just past the point where the oracle call itself returns zero |
| Underlying single-asset oracle freshness (XRP, USDC, ARMY) | `SecurdPriceOracle` per asset | Same treatment — a stale XRP price during a loop is just as dangerous as a stale LP price |

### 8.4 XRPL Ledger pool state (read before every `AMMDeposit`/`AMMWithdraw` preview)

| Metric | Source | UI behavior |
|---|---|---|
| Live reserves and ratio | `amm_info` on the relevant pool account (§0.1) | Used to *preview* the exact `Amount`/`Amount2` the dApp will submit, and to estimate undeployed leftover before the user signs (§7.3/§7.9), not just after |
| `asset2_frozen` | Same `amm_info` call | If `true`, block new `AMMDeposit`/`AMMWithdraw` actions outright and surface the freeze explicitly — ties directly to the freeze findings in `securd-asset-listing-risk-parameters.md` |
| Issuer flag changes (`lsfGlobalFreeze`, `lsfAllowTrustLineClawback`) | Periodic `account_info` on the underlying-asset issuers (§0.1) | These were verified FALSE/FALSE-with-known-exception at audit time — they are not immutable; the dApp (or an off-chain monitor feeding it) should re-check periodically, not assume the audit snapshot stays true forever |

### 8.5 Bridge infrastructure health (shared across all users, not position-specific)

| Metric | Source | UI behavior |
|---|---|---|
| Bridge adapter's native XRP balance (egress gas funding) | `provider.getBalance(adapterAddress)` on XRPL EVM, same check as this repo's existing `checkAdapterFunds.ts` | If below the threshold needed for an expected `BORROW`/`WITHDRAW` egress, warn before the user signs an intent that would otherwise revert on `egressGasValue` insufficiency |
| Per-market `Borrow Cap` utilization (§7.7) | `Comptroller`/`CToken` total borrows vs. configured cap | Show remaining headroom before letting a user start a loop that would need to draw more than what's left |
| Axelar relayer liveness (general) | Recent successful `searchGMP` executions across any account, sampled periodically | Protocol-level dashboard, not per-user — but should gate whether the dApp *recommends* starting a new loop right now |

### 8.6 Delta-neutral hedge tracking (§5, ongoing — not just at setup)

| Metric | Source | UI behavior |
|---|---|---|
| Current hedge ratio vs. target | Live `f·x` from `amm_info` vs. current XRP `borrowBalanceStored` for the proxy | Drift percentage shown continuously; rebalance prompt at the configured trigger threshold (§5.3) |
| Realized fee yield vs. hedge carry cost | AMM fee accrual (from LP token's growing redemption value) vs. XRP borrow-rate cost accrued | Net strategy P&L, not just raw hedge ratio — the point of the strategy is this number being positive |
| Time/price since last rebalance | Local state + oracle price snapshots | Used to drive both rebalance triggers from §5.3 simultaneously, and to show the user when the position is most exposed to gamma (right before the next rebalance) |

---

## 9. Resolving the signature burden — session-based delegated signing (§7.8)

§7.8 found that a realistic 4-loop sequence needs ~20 manual wallet signatures. There
are two structurally different signature layers bundled in that number, and they need
different fixes.

### 9.1 The two layers

| Layer | What it signs | Key type | Already decoupled from the other? |
|---|---|---|---|
| XRPL transaction signature | every `Payment`, `AMMDeposit`, `AMMWithdraw`, Add Gas `Payment` | XRPL account key (master, regular, or multisign) | — |
| Bridge intent signature | the `IntentEnvelope` payload embedded in each memo, checked against `intentSignerOfXrplAccount[xrplAccount]` | EVM (secp256k1) keypair | **Yes, already** — every script in this repo signs this with a separate key from the XRPL wallet |

The intent-signature layer is *already* structurally separable. The friction there isn't
signature count, it's that `setIntentSigner` is `onlyOwner` today (§9.3). The bulk of
the 20 signatures is entirely the XRPL transaction layer (§9.2).

### 9.2 XRPL transaction layer — native multisign session, no new amendment needed

**Recommended: 2-of-2 multisign with an ephemeral session key + a Securd policy
co-signer.**

Session start (one manual signature, the master key):
```
TransactionType: SignerListSet
Account: <user XRPL mainnet address>
SignerQuorum: 2
SignerEntries: [
  { SignerEntry: { Account: <ephemeral session pubkey>, SignerWeight: 1 } },
  { SignerEntry: { Account: <Securd policy co-signer address>, SignerWeight: 1 } }
]
```
The master key is **not** disabled (`lsfDisableMaster` left unset) — it always remains a
full-control override the user can fall back to at any time, independent of the session.

During the session: the dApp builds each transaction in §6, signs it locally with the
ephemeral key (held only in browser memory — never transmitted), and sends it to
Securd's policy co-signer service. The co-signer validates against a strict allowlist
before counter-signing:

| Check | Allowed values |
|---|---|
| `Destination` | `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` (gateway), or the two pool accounts in §0.1 — nothing else |
| Memo `type` | one of `interchain_transfer`, `call_contract`, `add_gas` |
| `Asset`/`Asset2` on `AMMDeposit`/`AMMWithdraw` | only the two approved currency/issuer pairs in §0.1 |
| Amount | within the loop budget the user approved at session start (e.g. "≤4 loops, ≤$X total borrowed") |

Only with *both* signatures present does the transaction validate — neither the
ephemeral key nor the co-signer alone can move funds. This is real least-privilege
delegation, not blind key-sharing, and it converts the manual-signature count for an
entire multi-loop sequence from ~20 down to 1 (setup) — see §9.4 for teardown.

**Lighter fallback (fewer moving parts, weaker scoping): `SetRegularKey` to a single
ephemeral key, no co-signer.** Removes all popups with one setup transaction, but that
key then has *full*, unscoped account control for the session's duration — if the
account holds anything else of value, it's equally exposed. If used, pair it with a
hard recommendation that users run leverage sessions from a dedicated, lightly-funded
sub-account rather than their primary wallet, to bound the blast radius. Treat this as
an MVP shortcut, not the target design — the 2-of-2 multisign above is the recommended
production path.

### 9.3 Bridge intent-signature layer — self-service rotation needed

`setIntentSigner(xrplAccount, signer)` is currently `onlyOwner` on
`XRPLSecurdBridgeAdapter` — only Securd's team can register which EVM key is authorized
to sign intents for a given `xrplAccount`. For self-service sessions at any scale, this
needs a self-service rotation path: the account's own authority (proven via a signed
XRPL-side proof — e.g. a one-time `Payment` from that account carrying the desired new
signer address in a memo, observed and validated by the contract or an authorized
relayer) should be able to register its own session signer, ideally with the same
lifecycle/expiry as the §9.2 session.

**This is a privileged surface and should not be bundled in casually**: whoever holds
the registered intent signer key can authorize `SUPPLY`/`BORROW`/`WITHDRAW`/`REPAY`
against that user's collateral. Treat any change here as requiring its own security
review — replay protection on the rotation proof, restricting rotation to the *current*
signer or the proven XRPL account holder only, and rate-limiting rotations — before it
ships, separately from the rest of this spec.

### 9.4 Session teardown

Either an explicit revocation `SignerListSet` (a second manual signature, removing the
ephemeral entry and restoring quorum to just the master key), or — preferably — bake an
expiry into the co-signer's own policy logic ("refuse to counter-sign anything after
timestamp T"), so the session degrades safely even if the user never explicitly closes
it or the browser tab is simply abandoned. Do both: off-chain expiry as the primary
control, on-ledger revocation as defense in depth.

### 9.5 Net effect

| | Before | After (§9.2 recommended design) |
|---|---|---|
| Manual signatures for a 4-loop sequence | ~20 | 1–2 |
| Who can move funds mid-session | anyone with the (unchanged) master key | only with *both* the ephemeral key *and* a policy-matching co-signer signature |
| Blast radius if the ephemeral key alone leaks | n/a (single key always had full control) | none — multisign requires the co-signer too |
| Blast radius under the §9.2 lighter fallback if the ephemeral key leaks | n/a | full account control for the session window |

---

## 10. Recommendations

- **Minimum position size before recommending looping**: given ~5–10 XRP overhead per
  loop (§3.4), a rough rule of thumb is not to loop below roughly $500–1,000 of starting
  equity, where overhead stays under ~1–2% of position value per loop.
- **Default loop count: 4.** Captures ~95%+ of theoretical max leverage for both pools
  (§3.3) without paying for diminishing-return loops.
- **Pre-fund Add Gas for every ITS leg** in any orchestration script, rather than
  reacting to stuck transfers after the fact (§7.4).
- **Gate loop/rebalance execution on oracle freshness**, not just price (§7.2).
- **Build the orchestration as a single off-chain script/bot** (similar in spirit to
  this repo's existing `runXrplLendingFlow.ts` pattern) that sequences all the intents
  in §6 with retries and gas top-ups built in — manual, one-intent-at-a-time execution
  by a human is not practical for a 4-loop leverage sequence with strict nonce ordering.
- **Confirm the liquidation keeper's XRPL-side unwind capability (§7.5) before
  enabling leverage publicly** — leverage increases the frequency and urgency of
  liquidations on exactly the collateral type that's hardest to liquidate quickly.
- **Adopt the §9.2 multisign session design before shipping the dApp flow** — a
  20-signature manual loop sequence is not a viable product surface, and the lighter
  `SetRegularKey`-only fallback trades away real security scoping; budget for the policy
  co-signer service, not just the contract-side `setIntentSigner` rotation (§9.3).
- **Always underpay the final `REPAY`, never overpay (§4, §7.10)** — verified directly
  against `CToken.repayBorrowFresh` that overpaying reverts the whole cross-chain
  execution rather than refunding the excess; any deleverage/unwind tooling must budget
  for a small intentional dust debt, not attempt an "exact" repay against a debt figure
  that keeps accruing interest during the relay window.
- **Implement §8's monitoring as the dApp's gating layer, not just its dashboard** —
  every "UI behavior" column in §8 is written as a precondition for allowing the next
  user action (start a loop, sign the next leg, trust a displayed price), not merely as
  informational display. Treat it as part of the spec, not a nice-to-have add-on.
