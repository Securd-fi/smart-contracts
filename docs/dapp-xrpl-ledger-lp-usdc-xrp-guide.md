# dApp Guide — LP, USDC and XRP via the Real XRPL Ledger → Axelar Path

Written for: the dApp developer. This is the implementation guide for the flow your UI needs to
replicate. It is based entirely on live mainnet transactions, all recorded with hashes in
[docs/lp-xrp-usdc-transaction-log.md](lp-xrp-usdc-transaction-log.md) — read that for the full
audit trail; this doc is the "how to build it" companion.

All three assets (LP, USDC, native XRP) have now been proven end-to-end, in both directions, from
a real XRPL Ledger account, through Axelar, into the lending markets and back out. One real
incident happened along the way (an LP withdraw that failed to arrive) and is explained below,
because it changes what your dApp must check before offering LP withdraw to users.

---

## 1. The five actions, and which mechanism each uses

| Action | Mechanism | Token amount travels inbound? | Decimals on EVM |
|---|---|---|---|
| SUPPLY | ITS (`interchain_transfer` + signed intent) | yes | LP: 15, USDC: 6, XRP: 18 |
| ENTER_MARKET | GMP (`call_contract`) | no | n/a |
| BORROW | GMP (`call_contract`) | no (egress sends tokens out after) | same as above |
| REPAY | ITS | yes | same as above |
| WITHDRAW | GMP (egress sends tokens out after) | no | same as above |

**The practical difference that matters:** for GMP actions, the native-XRP `Amount` of the XRPL
`Payment` *is* the gas — there's no separate gas field. For ITS actions, gas is a separate memo
field (`gas_fee_amount`), almost always sent as `0` and topped up afterward (see §3).

## 2. Decimals — the single most important thing to get right

| Asset | XRPL-side unit | EVM-side raw unit | Conversion |
|---|---|---|---|
| LP (XRP/USDC AMM share) | plain decimal value (e.g. `"1"`, `"0.5"`) | 15 decimals | `parseUnits(value, 15)` |
| USDC (USDC.axl) | plain decimal value | 6 decimals | `parseUnits(value, 6)` |
| Native XRP | drops (6 decimals) | 18 decimals | `drops × 10^12` |

**Never reuse a script for the wrong asset without checking its scaling line.** This test found the
bug twice already: `submitXrplWithdraw.ts` hardcodes `ethers.parseEther()` (18-decimal), which is
correct for XRP but was wrong for LP — a dedicated `submitXrplLpWithdraw.ts` had to be written with
`parseUnits(value, 15)`. If you add any other 15- or 6-decimal asset later, check this line first.

## 3. The two-hop gas pattern — expect to top up almost every ITS message

Every ITS message in this test (LP supply, USDC repay, the native-XRP top-up transfer) came back
`is_insufficient_fee: true` on its first check, because it was sent with `gas_fee_amount = 0`.
GMP messages (ENTER_MARKET, BORROW, WITHDRAW) generally did **not** need a top-up, because their
gas is paid directly in the Payment's `Amount`.

**Your dApp's flow for every ITS send should be:**
1. Send with `gas_fee_amount = 0` (or compute it properly if you'd rather pay upfront — this test
   always chose to top up after, which is simpler to reason about).
2. Check `https://api.axelarscan.io/gmp/searchGMP` with `{"txHash": "<lowercase hash>"}`.
3. If `is_insufficient_fee: true`, send an Add Gas top-up — same pattern as
   [scripts/sendXrplAddGasTopup.ts](../scripts/sendXrplAddGasTopup.ts): a `Payment` to the gateway
   with `type=add_gas` and `msg_id=<lowercase original tx hash>` memos.
4. **Size the top-up against the account's actual spendable balance**, not a fixed number. This
   test's proven reference was 30,000 drops, but one attempt failed with `tecUNFUNDED_PAYMENT`
   because the account only had ~11,155 drops spendable at that moment (see §5 below). Compute
   spendable = `balance − (reserve_base + owner_count × reserve_inc)` live via `server_state` and
   `account_info`, and never request more than that.

## 4. Checking whether a message actually finished — don't trust the top-level status alone

This is the mistake that made the LP incident (§6) look like a success for a few minutes.

**For a simple one-hop message**, `searchGMP` with `{"txHash": "<hash>"}` is enough.

**For any egress (EVM → XRPL, i.e. BORROW's or WITHDRAW's return leg), the message is two hops:**
`xrpl-evm → axelar hub → xrpl`. Querying by the EVM execution tx hash only shows the **first**
hop's status. To see whether it actually landed on XRPL:
1. Query `searchGMP` with `{"txHash": "<EVM execution hash>"}`.
2. Read the `executed.childMessageIDs` array from the response.
3. Query `searchGMP` again with `{"messageId": "<that child id>"}`. **This** is the real,
   final-destination status.

Even then, this test saw Axelarscan's status lag the real ledger state once (the XRP withdraw in
§6.2 of the transaction log showed `called`/`sent` a moment before the delivery `Payment` was
already visible in `account_tx`). **When you need certainty, check the destination ledger
directly** — the delivered trust line balance, or `account_tx`, not just Axelarscan.

## 5. XRPL reserve arithmetic — check before every Add Gas top-up

```
reserve = reserve_base + owner_count × reserve_inc   (read live via server_state)
spendable = account_balance − reserve
```

A top-up request above `spendable` fails with `tecUNFUNDED_PAYMENT` and still costs a small fee.
`owner_count` grows with every trust line and object the account holds, so this isn't a fixed
number — recompute it for the specific account before sizing a top-up.

## 6. The LP withdraw incident — what it means for your dApp

A withdraw of 0.5 LP was sent, executed correctly on XRPL EVM (the LP was burned there as part of
the outbound transfer), but failed to arrive on XRPL Ledger with `tecPATH_DRY`. Root cause,
confirmed by reading the failed transaction directly off the ledger: **the destination account's
own trust line for the LP currency had a limit of 0**, because it was auto-created by an
`AMMDeposit`, not a normal `TrustSet`. The Axelar gateway's own balance/trust limit was fine (a
wrong theory ruled out along the way — see the transaction log §5.1 for how that was checked).

**Fixing it:** a `TrustSet` raising the limit (see
[scripts/sendXrplLpTrustSet.ts](../scripts/sendXrplLpTrustSet.ts)) resolved it. A second withdraw
of the same size then succeeded and was confirmed on the XRPL trust line itself.

**This does not depend on the test — it depends on how any given user's LP trust line was
created.** Before your dApp offers an LP withdraw:
1. Check the user's own trust line for the LP currency (`account_lines`, filtered client-side —
   don't trust a `peer`-filtered server query alone, see §8).
2. If its limit is lower than what they're about to withdraw, prompt them to raise it with a
   `TrustSet` first, or raise it for them if your flow signs on their behalf.
3. Only then send the WITHDRAW intent.

Native XRP has no trust line and does not have this failure mode — the XRP withdraw in this test
succeeded on the first try, no incident.

**The first 0.5 LP burned in the failed attempt is still not recovered.** Recovering it requires
Axelar's own relay infrastructure (their XRPL multisig quorum signs destination deliveries; no key
this test holds can replace that). A message describing the stuck message ID has been prepared for
the Axelar team.

## 7. Known script bugs, cosmetic only, worth a quick fix

`submitXrplEnterMarket.ts` and `submitXrplWithdraw.ts` both hardcode `testnet.xrpl.org` and
`testnet.axelarscan.io` in their final `console.log`, regardless of which network was actually
used. Confirmed display-only in this test (every transaction was independently verified on
mainnet via `s1.ripple.com` directly) — but fix the two lines so a future operator isn't misled by
the printed link.

## 8. One tooling gotcha worth keeping

When checking an account's trust lines with `account_lines`, a `peer`-filtered query returned a
false empty result once in this test, even though the trust line existed. For any account with
many trust lines, paginate the full, unfiltered list (follow the `marker` field) and filter
client-side instead of trusting the server-side `peer` filter.

## 9. Checklist for implementing this in the dApp

- [ ] Use the correct decimal scaling per asset (§2) — write a single shared conversion function
      per asset, don't inline `parseEther`/`parseUnits` calls that could get copy-pasted wrong.
- [ ] For every ITS send, implement the check-then-top-up flow (§3), sized against live spendable
      balance, not a constant.
- [ ] For every egress (BORROW/WITHDRAW return leg), check the **child message**, not just the
      top-level hash (§4).
- [ ] Before offering LP withdraw, check and if needed fix the user's LP trust line limit (§6).
- [ ] Don't rely solely on Axelarscan's status for "is this actually done" — cross-check the
      destination ledger when it matters (§4).
- [ ] Fix the two hardcoded testnet links if you adopt these scripts directly (§7).

## 10. Reference: all addresses used in this test

| Item | Address |
|---|---|
| Bridge adapter | `0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848` |
| Axelar gateway (XRPL Ledger) | `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` |
| `sXRPUSDCLP` | `0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F` |
| LP token (underlying) | `0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53` |
| LP currency / issuer (XRPL) | `03B20F3A7D26D33C6DA3503E5CCE3E67B102D4D2` / `rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE` |
| `sUSDC` | `0x21Da09A16d69757C0731De3b83e65061BCF30E00` |
| USDC.axl currency / issuer (XRPL) | `555344432E61786C000000000000000000000000` / `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` (the gateway itself) |
| `sXRP` | `0xEFedd95eFdB71652bd93F58b2B7F77748Dee04F6` |
| Native XRP precompile (EVM) | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` |

Full transaction hashes for every step above are in
[docs/lp-xrp-usdc-transaction-log.md](lp-xrp-usdc-transaction-log.md).
