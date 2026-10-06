# dApp Plan — XRP/USDC LP Collateral Test Flow (XRPL wallet path)

Written for: the dApp developer and the Securd team. This is the plan for the dApp's test flow (handoff §0). It covers the XRPL-wallet path that real users take, not the EVM `cast` steps used for our own test wallet.

**Status:** plan only. Implementation starts after the LP price is live on-chain (see §1). Nothing in this document has been run against mainnet by this plan.

---

## 1. Gates (must all be true before the UI opens the test)

| Gate | How to check | Owner |
|---|---|---|
| LP price is posted and fresh (under 15 minutes old) | `fallbackPriceOf(0xbAF2…f53)` on the oracle `0xeB8F…F98` returns a non-zero price and a recent timestamp | Bot (dApp backend cron) |
| LP borrow is paused | `borrowGuardianPaused(0xBC08…70F)` returns `true` on the Comptroller `0xf263…405E` | Pause guardian `0xd91A…4c0AE` |
| Price formula is approved in writing | Written sign-off from the protocol owner. The bot must not post until this is in place. | Protocol owner |
| LP collateral factor is 35% | `markets(0xBC08…70F)` second value is `350000000000000000` | Owner, through the timelock, on or after 2026-10-07 11:34 UTC |
| Canary of the LP supply path has passed | Section 4, step 3 | Dev team |

If any gate is false, the dApp shows the LP market as "not open yet" and does not offer any LP action.

## 2. Who is allowed in

Allowlist, not public. Only XRPL accounts on the test list see the LP market, and they see a visible "test market — small amounts — policy waiver" banner on every LP screen. The list is maintained by the team, not by the UI.

## 3. Flow, step by step

Each step below is an XRPL transaction that carries an intent envelope in its memo. The intent signer key signs the envelope. That key is registered on the bridge adapter for the user's XRPL account. The user does not hold an EVM key.

**Warning:** signed intent envelopes are immutable once sent. A wrong amount or token cannot be corrected. Only the fee can be topped up. Build and check each envelope before sending.

| # | User action | Mechanism | Existing script | Notes |
|---|---|---|---|---|
| 1 | Hold LP on XRPL | LP trustline, currency `03B20F3A7D26D33C6DA3503E5CCE3E67B102D4D2`, issuer = the XRP/USDC AMM LP account | none | The user needs LP on XRPL Ledger first. The test wallet holds it from the AMM deposit. |
| 2 | Supply LP | ITS transfer of the LP token with a SUPPLY envelope, to the bridge adapter | **none yet — must be written** | Adapter mapping is already live: `marketConfigOf(sXRPUSDCLP)` = LP token, tokenId `0xe2f2d147…6e291b`, `listed = true`. See §4, step 3. |
| 3 | Enter the LP market | GMP call, native XRP Amount is the gas | `scripts/submitXrplEnterMarket.ts` | This script is hardcoded to the sXRP market example and defaults to testnet. Override `XRPL_RPC_URL`, `XRPL_AXELAR_GATEWAY` (`rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`), and `XRPL_DEPOSIT_MARKET` (`0xBC08…70F`). Its default gas is 3,000,000 drops, which overpays. Size it with the estimator. |
| 4 | Borrow USDC | GMP call, USDC.axl | `scripts/submitXrplUsdcBorrow.ts` | `XRPL_USDC_MARKET` = `0x21Da…0E00` (sUSDC). Amount is a string such as `"0.01"`. Cap the input at the sUSDC cash (`getCash()`). Mainnet defaults are set in this script. |
| 5 | Repay USDC | ITS transfer, USDC.axl, with gas memo | `scripts/submitXrplUsdcRepay.ts` | Repay the current borrow balance, not the original borrow amount. |
| 6 | Withdraw LP | GMP call | `scripts/submitXrplWithdraw.ts` | Only after repay and when no liquidation risk is open. |

**USDC rule:** use USDC.axl only (issuer `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`, currency `555344432E61786C000000000000000000000000`). Circle USDC on the same ledger bridges to a different 15-decimal token and is not sUSDC. Using it is unrecoverable. The full comparison is in `docs/xrpl-evm-mainnet-dapp-developer-guide.md` §2.4.

**Gas rule:**
- GMP actions (enter market, borrow, withdraw): the native XRP Amount of the Payment is the gas. Size it with `scripts/estimateXrplBridgeGasFee.ts`.
- ITS actions (supply, repay): the `gas_fee_amount` memo is a separate amount on top of the transferred value. Or top up later with `scripts/sendXrplAddGasTopup.ts`.
- If Axelarscan shows `is_insufficient_fee: true`, top up. Do not resubmit.

## 4. Before the UI goes live

1. **Dry run every step with `XRPL_CONFIRM_SEND` unset** (preview only), and check each envelope against the table above.
2. **Canary with 0.001 LP** from the test XRPL account, first through the supply step only. Check on Axelarscan that the message completed, then check the LP cToken balance on `0xBC08…70F` for the account's EVM address.
3. **Supply canary.** The supply script does not exist yet. It must be written as a variant of `submitXrplUsdcSupply.ts` that sends the LP token (15 decimals, not 6), with the LP tokenId `0xe2f2…` and the adapter `0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848`. Verify it on the 0.001 LP canary before any user uses it. Today the only proof is the plain ITS canary with no payload, which delivered 0.001 LP to the EVM side. The adapter SUPPLY path for LP is not proven.
4. **Enter, borrow, repay** each on a small canary (0.01 USDC for the borrow), with the sUSDC cash check before each borrow.
5. **Record each transaction hash** in `docs/lp-collateral-test-run.md`, with the XRPL tx, the Axelarscan link, and the EVM tx.

## 5. UI requirements (from handoff §0)

- Three LP price states: no price (`updatedAt` = 0), stale (older than 15 minutes), live.
- Show the LP market as "not available yet" in the first two states. Do not show a stale number as current.
- Translate error `13` (`PRICE_ERROR`) into "price not available yet". Do not show a generic failure.
- Cap the borrow input at the sUSDC cash shown by `getCash()`.
- Show the test banner on every LP screen.
- The dApp never holds or reads a team key.

## 6. Open items and risks

- The supply script for LP does not exist. It is the largest unknown in the flow.
- The LP market's borrow pause must be in place before the price goes live, or LP can be borrowed by any account with other collateral.
- The price formula change is not yet approved. The bot must not post until it is.
- The TVL floor in the test config is $25K, against the $50K policy floor. The banner must state the waiver.
- Unpausing borrow later is admin-only and goes through the timelock.

## 7. Decision needed from the team

- Confirm the allowlist approach (recommended) or public display with the banner.
- Confirm that step 3 (LP supply canary) must pass before any user, including the team's own test accounts, uses the flow.
