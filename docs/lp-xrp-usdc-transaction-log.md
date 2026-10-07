# XRP/USDC LP Collateral Test — XRPL Ledger Mainnet Transaction Log

Scope: only transactions sent **from the XRPL Ledger mainnet account**, through the real
Axelar bridge/intent path used by the dApp — not the EVM-direct test calls made earlier in this
test. This is the actual end-user flow: sign on the XRPL Ledger, Axelar relays it, the bridge
adapter executes on XRPL EVM.

**Account:** `rPAdN2a4qHwVoFG8b6mthGeqo5UfMHjNTp` (XRPL Ledger mainnet).
**EVM proxy:** `0x0d563E8170e6f2972fD580c7588c726007dcbf6e` (XRPL EVM mainnet, chain ID `1440000`),
created by `XRPLUserProxyFactory` (`0x06B219Afe66EB4A2508D1c0F1ab4102d5cF776fA`) — this proxy, not
the XRPL account's own address, holds the cTokens and is what the Comptroller reads for liquidity.
**Bridge adapter:** `0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848`.
**Axelar gateway on XRPL Ledger:** `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`.
**Intent signer registered for this account:** `0x200Ac4adc56C04EBb69be67484404eefECe4D06B`
(confirmed matching `intentSignerOfXrplAccount` on the adapter before sending anything).

**Status: all three assets proven end-to-end via the real XRPL Ledger → Axelar path** — LP supply,
LP enter-market, LP withdraw, USDC borrow/repay, and XRP supply/withdraw. One real incident
occurred and is documented in full in §5: a withdraw of 0.5 LP failed to arrive on XRPL Ledger
the first time, was traced to a real root cause, fixed, and a second withdraw then succeeded. The
XRP leg (§6) and the rest of the USDC/LP legs had no such incident.

---

## 1. LP supply (1 LP)

This proved, for the first time live, the SUPPLY intent path for the LP token — previously this
was only proven for a 0.001 LP dust canary with a plain transfer (no intent), and the full intent
path was an open item in the test plan.

**Mechanism:** the XRPL account sends a `Payment` of the LP IOU to the Axelar gateway, with memos
describing an `interchain_transfer`, the destination adapter address, destination chain, and a
signed intent payload (the envelope: account, market, underlying, action type SUPPLY, amount,
nonce, deadline, signed by the registered intent signer). Axelar relays it to Axelar hub, then to
XRPL EVM, where the adapter verifies the signature and mints `sXRPUSDCLP` for the proxy.

**Script:** [scripts/submitXrplLpSupply.ts](../scripts/submitXrplLpSupply.ts).

**Decimals:** the LP token has 15 decimals on the EVM side. 1 LP → `1000000000000000` raw.

| Step | Detail |
|---|---|
| XRPL currency / issuer | `03B20F3A7D26D33C6DA3503E5CCE3E67B102D4D2` / `rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE` (the XRP/USDC AMM account) |
| EVM token ID (checked against the adapter before sending) | `0xe2f2d147cc5da2f15c947b85d9a0bd88dc7e64bf864725a76b064002a06e291b` |
| Nonce used | 6 |
| Intent id | `0x0e5bfa4f4ae60cf333c847a6598c1b8ba0831e69d214d536446c85818da63758` |

**Transactions:**
1. **XRPL Payment (SUPPLY intent):** `9D62BCBC1B7A0CE1D023A212D0AD3075DB253293E38D8AE43A67654088D03A9A` — `tesSUCCESS`. Sent with `gasFeeToken=0` (no in-kind gas).
2. **Axelar relay result:** came back `is_insufficient_fee: true` (checked via `api.axelarscan.io/gmp/searchGMP`) — the message reached the Axelar hub but had no gas to go further.
3. **Add Gas top-up, 30,000 drops:** `940E39B3B3E3059E7192D42B33A34830EE6FF5DBEC2F3379F5245310496D17DF` — `tesSUCCESS`, sent with [scripts/sendXrplAddGasTopup.ts](../scripts/sendXrplAddGasTopup.ts). This amount matched what an earlier, smaller LP canary needed, so it was used again rather than re-deriving a fee estimate.
4. **EVM execution:** `0xb7eb1c33107fca45afdf2e0d111b5e8e616e31170410a5362181a1f17e19c774`, block `8034275`. Axelarscan then showed `status: executed`, `is_insufficient_fee: false`.

**Verified result:**
- Proxy's `sXRPUSDCLP` balance: `1000000000000000` (1 LP), confirmed with `balanceOf` on the cToken.
- XRPL-side LP trustline dropped from `273.56043972` to `272.56043972` (checked with `account_lines`).

**Important correction, found later (§4):** this supply alone did **not** make the LP count as
collateral. `checkMembership` stayed `false` and `getAssetsIn` did not include the LP market until
`ENTER_MARKET` (§4) was separately sent. A 0.01 USDC borrow done between §1 and §4 was backed
**entirely** by this account's pre-existing `sXRP`/`sUSDC` collateral (from an earlier, separate
test), not by any part of this LP — this was caught by the dApp developer's own review, not by
this audit, and is recorded here as the correction it is.

## 2. USDC borrow (0.01 USDC)

**Mechanism:** BORROW is a GMP (`call_contract`) action, not a token transfer — nothing is bridged
inbound. The entire native-XRP `Amount` of the Payment is the gas (not a separate memo field, this
is the rule for GMP actions as opposed to ITS actions). The adapter executes the borrow on behalf
of the proxy, then pushes the borrowed USDC back to the XRPL account itself via its own outbound
ITS transfer (`_egress`), which needs the adapter to hold at least its configured
`egressGasValue` in native XRP up front (it held 0.9 XRP; needed 0.35).

**Script:** [scripts/submitXrplUsdcBorrow.ts](../scripts/submitXrplUsdcBorrow.ts). Note: this
script's env var for the intent-signer key is (confusingly) named `DEPLOYER_PRIVATE_KEY`, not
`INTENT_SIGNER_PRIVATE_KEY` — it was set to the same intent-signer key, scoped to this one command
only, never to the real deployer key.

**Decimals:** `sUSDC` underlying has 6 decimals. 0.01 USDC → `10000` raw.

| Step | Detail |
|---|---|
| Market / underlying | `sUSDC` `0x21Da09A16d69757C0731De3b83e65061BCF30E00` / `0xa16148c6Ac9EDe0D82f0c52899e22a575284f131` |
| Nonce used | 7 |
| Intent id | `0xdb44ecd147799061d30271ecaf117972c1799691c14b8f422d020231a183918d` |
| Gas Payment (native XRP, this is the gas itself for GMP) | 30,000 drops |

**Transactions:**
1. **XRPL Payment (BORROW intent, GMP):** `69A3DA82544B185C42AB3F07EAD5C3A6A7AE9B674FB4254CE99017D297998266` — `tesSUCCESS`.
2. **EVM execution (borrow + egress triggered):** `0x9af4d7e3a8c774efdc1b03b1c0310bdd5b892c5a84d4c1f1ebf17021546a4576`, block `8034351`. This single EVM transaction both executed the borrow on `sUSDC` and fired the adapter's own outbound ITS transfer back to the XRPL account — confirmed by `InterchainTokenService`/`AxelarGasService`/`AxelarGateway` events in its logs.
3. **Egress leg tracked separately on Axelarscan**, using the EVM tx hash (not the XRPL one, since this message runs EVM → Axelar → XRPL): `status: executed`, `is_insufficient_fee: false`.

**Verified result:**
- Proxy's `sUSDC` borrow balance: `10000` (0.01 USDC), via `borrowBalanceStored`.
- XRPL-side USDC.axl trustline rose from `0.02` to `0.03` — the borrowed USDC actually arrived back on the Ledger, not just as an EVM-side debt.
- **As corrected in §1: this was backed entirely by pre-existing `sXRP`/`sUSDC` collateral, not by the LP.**

## 3. USDC repay (0.01 USDC)

**Mechanism:** REPAY is an ITS action (like SUPPLY): the XRPL account sends the USDC.axl IOU itself
to the gateway, with a signed intent envelope (action type REPAY). No egress destination is needed,
since nothing comes back.

**Script:** [scripts/submitXrplUsdcRepay.ts](../scripts/submitXrplUsdcRepay.ts). This one uses the
correctly named `INTENT_SIGNER_PRIVATE_KEY`.

| Step | Detail |
|---|---|
| Currency / issuer | `555344432E61786C000000000000000000000000` ("USDC.axl") / `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` (the gateway itself) |
| Adapter token ID (checked before sending) | `0xaab70a74fae5d4d70134970cc0a7a03ff70bfffd5891f79d2f4daf1b5fade846` |
| Nonce used | 8 |
| Intent id | `0xa59e1eb16f068888c2522349777f32eba81c838bc46bdd985b866b1684789938` |

**Transactions, including a real reserve-driven failure:**
1. **XRPL Payment (REPAY intent):** `DC41EE1878A02C3FD4DF573719816595DC1982F114E71F345788D4E1978A6D5E` — `tesSUCCESS`. Sent with `gasFeeToken=0`.
2. **Axelar relay result:** `is_insufficient_fee: true` again.
3. **Add Gas top-up attempt, 30,000 drops — FAILED, `tecUNFUNDED_PAYMENT`:** `6269D01B30ECF87C092696F6CC8D694887D241E6224855F5AF6F95E5CB052211`. Cause: the account's XRPL reserve had grown to 1,600,000 drops (base reserve 1,000,000 + 3 trustlines × 200,000 owner reserve), and the account's balance at that moment (1,611,155 drops) left only **~11,155 drops spendable** — less than the 30,000 requested. The earlier top-ups had been drawing this account down with no replenishment.
4. **Add Gas top-up, 10,000 drops — succeeded:** `FB894961549F109141A8C1E6A4E6A0C4469E16702D803405B00B8A82A7C73874`. Sized to what was actually spendable, not to the earlier proven-amount reference.
5. **EVM execution:** confirmed via Axelarscan on the XRPL tx hash: `status: executed`, `is_insufficient_fee: false`.

**Verified result:**
- Proxy's `sUSDC` borrow balance: back to `0`.
- Account liquidity restored to ≈$0.782 (from the account's pre-existing `sXRP`/`sUSDC` collateral,
  supplied in an earlier, separate test — not part of this LP test).

## 4. LP enter-market (the missing collateral step)

Found by the dApp developer's own review, not by this audit: after §1, the LP sat in the proxy as
a plain cToken balance but was never entered as collateral. `checkMembership(proxy, sXRPUSDCLP)`
was `false`, and `getAssetsIn(proxy)` was `[sXRP, sUSDC]` — no LP.

**Mechanism:** `ENTER_MARKET` is a GMP action. The adapter calls `comptroller.enterMarkets([market])`
on the proxy's behalf. No token amount is involved, so this action is not exposed to any decimal
scaling bug.

**Script:** [scripts/submitXrplEnterMarket.ts](../scripts/submitXrplEnterMarket.ts), with its
testnet defaults (`XRPL_RPC_URL`, `XRPL_AXELAR_GATEWAY`) overridden to mainnet, and
`XRPL_DEPOSIT_MARKET`/`XRPL_DEPOSIT_UNDERLYING` pointed at `sXRPUSDCLP`/the LP token.

**Known cosmetic bug, found while running this:** the script's final `console.log` hardcodes
`https://testnet.xrpl.org/...` and `https://testnet.axelarscan.io/...` regardless of which network
was actually used. Verified this is display-only: the transaction itself was confirmed on mainnet
by querying `s1.ripple.com` directly for the same hash. `submitXrplWithdraw.ts` has the same two
hardcoded lines. Worth a one-line fix in both scripts so a future operator isn't misled.

| Step | Detail |
|---|---|
| Nonce used | 9 |
| Gas Payment | 30,000 drops |

**Transaction:**
1. **XRPL Payment (ENTER_MARKET intent, GMP):** `D546F602FB059801C6DF8515CAD5FF8D7733632D1F5E0E8054514BA1AA4B2D6D` — `tesSUCCESS`. No Add Gas top-up was needed this time (`is_insufficient_fee: false` on the first check).

**Verified result:**
- `checkMembership(proxy, sXRPUSDCLP)`: now `true`.
- `getAssetsIn(proxy)`: now `[sXRP, sUSDC, sXRPUSDCLP]`.
- Account liquidity: ≈$0.779 (the LP's own contribution is still tiny at this size — about $0.0007 — most of the liquidity remains the pre-existing `sXRP`/`sUSDC`).

## 5. LP withdraw — one failed attempt, a real incident, then fixed and proven

This is the single most important leg of this test: it is the only path that brings LP collateral
back out to XRPL Ledger. The dApp developer flagged, before this was attempted, that a failure
here would leave real users' LP permanently stuck on the EVM side. That risk materialized on the
first attempt, below, and was then traced, fixed, and re-proven.

**Mechanism:** WITHDRAW is a GMP action. The adapter calls `redeemUnderlying` on the proxy's
`sXRPUSDCLP` position, pulls the redeemed LP to itself, then sends it back to the XRPL account via
its own outbound ITS transfer — the same `_egress` pattern as the USDC borrow in §2, but for a
third-party-issued IOU (the LP token) instead of a gateway-issued one (USDC.axl). This difference
turned out to matter (see the incident below).

**Script written for this:** [scripts/submitXrplLpWithdraw.ts](../scripts/submitXrplLpWithdraw.ts),
a variant of `submitXrplWithdraw.ts`. The original hardcodes `ethers.parseEther()` — 18-decimal
scaling, correct only for native XRP. The LP token has 15 decimals; used as-is, the withdraw amount
would have been wrong by a factor of 1000, the same class of bug the USDC gotcha already taught
once. The new script uses `ethers.parseUnits(value, 15)`.

### 5.1 First attempt (0.5 LP) — failed, funds burned on EVM, not delivered on XRPL

1. **XRPL Payment (WITHDRAW intent, GMP):** `B6CD1693256FBF78E3B5D40CDBC189A9FE31D4C6CE951BF6A0BBC74E52228EA6` — `tesSUCCESS`. 30,000 drops gas, no top-up needed.
2. **EVM execution:** `0x0270d9da88c8480b17060029a1259c7a474a0157fa9166773b32ccb575fcfa2e`, block `8036737`. `redeemUnderlying` ran; proxy's `sXRPUSDCLP` balance dropped from 1 LP to 0.5 LP; the LP token's EVM `totalSupply` dropped from 1.001 LP to 0.501 LP — **the 0.5 LP was burned on the EVM side** as part of the outbound ITS transfer, before destination delivery was known to succeed.
3. **First hop (EVM → Axelar hub):** succeeded, confirmed.
4. **Second hop (Axelar hub → XRPL Ledger): FAILED.** The actual XRPL delivery transaction, `2EEF0E54E31AB022580C3EA33A0D0A1099B5DADF1DDD370C403BA4901149AB3A`, returned `tecPATH_DRY`. Found by looking up the child message ID from the first hop's `executed` object and querying Axelarscan by `messageId` rather than `txHash` (the top-level `txHash` query only shows the first hop's status).

**Where the 0.5 LP sat at this point:** nowhere recoverable on EVM — not in the adapter, the proxy, the ITS contract, or the token manager (all checked, all zero). Burned on the source side, not delivered on the destination side.

**Root cause, investigated directly on the ledger (one wrong theory ruled out first):**
- First theory, **wrong, and corrected**: that the Axelar gateway had no trust line with the LP issuer. A `peer`-filtered `account_lines` query gave a false empty result. A full, paginated scan of the gateway's actual 3,999 trust lines found it: the gateway holds `1.001 LP`, unlimited trust limit. Not the problem.
- **Real cause:** pulling the failed Payment transaction directly from the ledger (`tx` method) showed its metadata touched only the gateway's own account (fee, ticket) — the recipient's trust line was never touched, meaning the payment engine found no valid path *before* even reaching the destination. Checking the recipient's own trust line confirmed why: `rPAdN2a4...`'s trust line toward the LP issuer had **`limit: "0"`**, `no_ripple: true`, despite already holding a balance of 272.56043972 — this line was auto-created by an earlier `AMMDeposit`, not a standard `TrustSet`, and auto-created AMM LP trust lines apparently don't get a normal receiving limit.

### 5.2 Fix — raise the destination trust line limit

**Script written for this:** [scripts/sendXrplLpTrustSet.ts](../scripts/sendXrplLpTrustSet.ts). A
`TrustSet`, not a payment — moves no funds, only changes how much of the currency the account is
willing to hold.

1. **TrustSet, limit raised to 1,000,000,000:** `4D44F1150A6EF6F427D9A27F2577AA69431FA707FCFF6DA7975C0260E4418236` — `tesSUCCESS`. Verified with `account_lines`: limit is now `1000000000` (was `0`).

### 5.3 Second attempt (the remaining 0.5 LP) — succeeded end-to-end

First, the adapter's own native-XRP balance needed topping up: it had dropped from 0.55 XRP to
0.2 XRP after the first attempt (the egress gas, 0.35 XRP, is spent on the source chain regardless
of whether the destination delivery succeeds), below the 0.35 XRP the next egress would need.

**Funding the adapter, using funds already held on this test's XRPL Ledger account** (not a new
external deposit): a plain Axelar ITS transfer of native XRP, no signed intent needed, same
pattern as the original LP dust canary — script written for this:
[scripts/sendXrplNativeToEvmAddress.ts](../scripts/sendXrplNativeToEvmAddress.ts).

1. **XRPL Payment, 1 XRP, plain transfer to the adapter's EVM address:** `E6C064D46490E11C3453BAE1AFF71D264D8C68A352ED41BF76C5330A161010C8` — `tesSUCCESS`.
2. **Add Gas top-up, 30,000 drops** (same `is_insufficient_fee` pattern as every other message in this test): `FF3889E12CE07AF78253AEA247301CB575823AB31B683F5608C2CF0CB6401FF6`.
3. **Result:** adapter balance rose to 1.2 XRP, confirmed with `cast balance`.

**The withdraw itself, resent for the remaining 0.5 LP:**
1. **XRPL Payment (WITHDRAW intent, GMP):** `14FA5D878681FF8F323A2184888E26E2756C87FB687AF43D404B4C0F289799EE` — `tesSUCCESS`.
2. **EVM execution:** `0xa63d257a622f72fcb1338797c4089769cca2c5f9fb1b37cf6fd9c373987d8eef`. Proxy's `sXRPUSDCLP` balance went from 0.5 LP to `0`.
3. **Second hop, checked by child message ID, not the top-level hash:** `status: executed`, `simplified_status: received`, `error: null`.
4. **XRPL-side confirmation — the actual proof:** the LP trust line rose from `272.56043972` to `273.06043972`, an increase of exactly `0.5` LP. **Delivered.**

### 5.4 Open, unresolved: the first 0.5 LP

The 0.5 LP burned in §5.1 is still not recovered. It is not a contract-level bug and nothing in
this repo or any key used in this test can recover it — the XRPL-side delivery for a failed
message requires Axelar's own XRPL multisig quorum (the failed transaction had ~19 `Signer`
entries from Axelar's relay infrastructure) to co-sign a fresh delivery. A message to the Axelar
team has been prepared, asking (1) whether message
`0x0270d9da88c8480b17060029a1259c7a474a0157fa9166773b32ccb575fcfa2e-14` can be retried now that
the destination trust line is fixed, since the source-side funds were already debited, and (2)
whether ITS pre-checks destination trust line limits before attempting XRPL delivery.

### 5.5 What this means going forward

- **The WITHDRAW mechanism itself works**, proven end-to-end after the fix.
- **This specific failure mode is about the destination account's own trust line setup**, not the
  protocol. Any XRPL account whose LP trust line was created via `AMMDeposit` (limit 0) will hit
  the same `tecPATH_DRY` on its first withdraw. The dApp should check and, if needed, prompt the
  user to raise their trust line limit before a withdraw is attempted — or the loss risk the
  developer originally flagged is real for any such user, not just this test account.

## 6. XRP as a collateral action — proven end-to-end, no incident

Unlike the LP withdraw (§5), this leg succeeded on the first attempt for both directions. The
difference: native XRP needs no trust line at all, so the failure mode that hit the LP IOU egress
(a destination trust line limit of 0) does not apply here.

**Mechanism — SUPPLY:** an ITS action. The account sends native XRP (as drops) to the gateway,
with a signed intent envelope (action type SUPPLY). The ITS scales drops (6 decimals) up by
`10^12` to the 18-decimal EVM amount. **Script:**
[scripts/submitXrplDeposit.ts](../scripts/submitXrplDeposit.ts). Note its `XRPL_DEPOSIT_DESTINATION_ADDRESS`
env var is the GMP/ITS destination **contract** (the adapter), not an XRPL address — easy to
misread given the name.

**Mechanism — WITHDRAW:** a GMP action, same pattern as the LP withdraw in §5, using the
unmodified `submitXrplWithdraw.ts` (its `ethers.parseEther()` 18-decimal scaling is correct here,
since XRP genuinely has 18 decimals on the EVM side — this script should **not** be reused as-is
for any other asset).

### 6.1 Supply (0.3 XRP)

| Step | Detail |
|---|---|
| Market / underlying | `sXRP` `0xEFedd95eFdB71652bd93F58b2B7F77748Dee04F6` / native precompile `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` |
| Nonce used | 12 |
| Drops → EVM scaling | `300000` drops → `300000000000000000` wei (×10^12) |

1. **XRPL Payment (SUPPLY intent, ITS):** `94E250CB3FC5E7001F3B10DBF39C366D3A526B3A1F1877D4B6DF9BCD632AE537` — `tesSUCCESS`.
2. **Add Gas top-up, 30,000 drops** (same `is_insufficient_fee` pattern as every ITS message in this test): `2DB92CD779DF8D958AAFFEEC7713C040730089DFCAF10ABC410BE33B94302E03`.
3. **Verified result:** proxy's `sXRP` balance rose from `0.7` to `1.0` XRP — exactly the 0.3 XRP supplied.

### 6.2 Withdraw (0.1 XRP)

| Step | Detail |
|---|---|
| Nonce used | 13 |
| Gas Payment (GMP, this is the gas itself) | 30,000 drops |

1. **XRPL Payment (WITHDRAW intent, GMP):** `2989C217B202EAAD1A0EF8A9FCCB73D7D66C462456030C3FA36C8377AADAE78C` — `tesSUCCESS`. No top-up needed (`is_insufficient_fee: false` immediately — GMP gas is paid upfront in the Payment itself, unlike ITS).
2. **EVM execution:** `0x3f80a75cbfcc7e56cd26b983f9bc4d5997f5e86b080ff489e32d3fb7e1b646df`. Proxy's `sXRP` balance dropped from `1.0` to `0.9` XRP.
3. **Second hop, checked by child message ID** (see §7 for why this matters): `status: called`, `simplified_status: sent` — looked unfinished at the time it was checked.
4. **Actual delivery, confirmed directly from `account_tx` rather than trusting the in-flight Axelarscan status:** a `Payment` from the gateway to `rPAdN2a4...` for exactly `100000` drops (0.1 XRP), `tesSUCCESS`. **Delivered**, even though Axelarscan's status check a moment earlier still showed it in flight — Axelarscan can lag the actual ledger state; when in doubt, check the ledger directly.

**Known cosmetic bug, same family as §4/§7:** `submitXrplWithdraw.ts`'s dry-run message and final
links also say "testnet" regardless of actual network — confirmed display-only again here.

## 7. Scripts reference

| Script | Action | Key env vars | Confirm flag |
|---|---|---|---|
| [scripts/submitXrplLpSupply.ts](../scripts/submitXrplLpSupply.ts) | LP SUPPLY, ITS | `XRPL_SEED`, `INTENT_SIGNER_PRIVATE_KEY`, `XRPL_LP_SUPPLY_AMOUNT` | `XRPL_CONFIRM_SEND=true` |
| `scripts/submitXrplUsdcBorrow.ts` | USDC BORROW, GMP | `XRPL_SEED`, `DEPLOYER_PRIVATE_KEY` (= intent signer key here), `XRPL_USDC_BORROW_AMOUNT` | `XRPL_CONFIRM_SEND=true` |
| `scripts/submitXrplUsdcRepay.ts` | USDC REPAY, ITS | `XRPL_SEED`, `INTENT_SIGNER_PRIVATE_KEY`, `XRPL_USDC_REPAY_AMOUNT` | `XRPL_CONFIRM_SEND=true` |
| `scripts/submitXrplEnterMarket.ts` | ENTER_MARKET, GMP | `XRPL_SEED`, `DEPLOYER_PRIVATE_KEY` (= intent signer key here), `XRPL_DEPOSIT_MARKET`, `XRPL_DEPOSIT_UNDERLYING` | `XRPL_CONFIRM_SEND=true` |
| `scripts/submitXrplDeposit.ts` | XRP SUPPLY, ITS | `XRPL_SEED`, `INTENT_SIGNER_PRIVATE_KEY`, `XRPL_DEPOSIT_DESTINATION_ADDRESS` (= adapter address), `XRPL_DEPOSIT_AMOUNT_DROPS` | `XRPL_CONFIRM_SEND=true` |
| `scripts/submitXrplWithdraw.ts` | XRP WITHDRAW, GMP (correct as-is: native XRP really is 18 decimals) | `XRPL_SEED`, `DEPLOYER_PRIVATE_KEY`, `XRPL_WITHDRAW_AMOUNT_XRP` | `XRPL_CONFIRM_SEND=true` |
| [scripts/submitXrplLpWithdraw.ts](../scripts/submitXrplLpWithdraw.ts) | LP WITHDRAW, GMP | `XRPL_SEED`, `INTENT_SIGNER_PRIVATE_KEY`, `XRPL_LP_WITHDRAW_AMOUNT` | `XRPL_CONFIRM_SEND=true` |
| [scripts/sendXrplLpTrustSet.ts](../scripts/sendXrplLpTrustSet.ts) | Raise a trust line limit (no funds moved) | `XRPL_SEED`, `XRPL_LP_TRUST_LIMIT` | `XRPL_CONFIRM_SEND=true` |
| [scripts/sendXrplNativeToEvmAddress.ts](../scripts/sendXrplNativeToEvmAddress.ts) | Plain native-XRP transfer to any EVM address (e.g. topping up a contract's gas reserve) | `XRPL_SEED`, `XRPL_NATIVE_AMOUNT_DROPS`, `XRPL_EVM_DESTINATION` | `XRPL_CONFIRM_SEND=true` |
| `scripts/sendXrplAddGasTopup.ts` | Gas top-up for an underfunded Axelar message | `XRPL_SEED`, `ADD_GAS_MSG_ID`, `ADD_GAS_DROPS` | none — sends on invocation, so check `ADD_GAS_DROPS` against spendable balance first |

**All `submitXrpl*`/`sendXrpl*` scripts except the Add-Gas one are dry-run safe by default**
(no `XRPL_CONFIRM_SEND` → prints the envelope/payment, sends nothing).
`sendXrplAddGasTopup.ts` has no dry-run mode, so check the account's spendable balance before
setting `ADD_GAS_DROPS`.

**Known cosmetic bug:** `submitXrplEnterMarket.ts` and `submitXrplWithdraw.ts` both hardcode
`testnet.xrpl.org`/`testnet.axelarscan.io` in their final `console.log`, regardless of which
network was actually used. Confirmed display-only, not a real misdirection — verify any such
transaction directly against `s1.ripple.com` rather than trusting the printed link.

**Common pattern for every `submitXrpl*` script:**
1. Reads the XRPL account's next nonce and the adapter's registered intent signer, and refuses to
   build an envelope if the local signer key doesn't match.
2. Checks the target market is listed on the adapter and its underlying/token ID match what's
   expected, so a misconfigured market fails before anything is signed.
3. Builds and signs the intent envelope (digest over adapter address, chain id, and the envelope
   fields), then embeds it in the XRPL `Payment`'s memos.
4. Prints the full envelope and payment for inspection. **Only sends if `XRPL_CONFIRM_SEND=true`.**
5. On send, submits and waits for XRPL validation, then prints the XRPL tx hash and the
   corresponding Axelarscan link.

**Checking a message after sending**, two ways used throughout this test:
- `https://axelarscan.io/gmp/<tx hash, lowercase>` in a browser, or
- `curl -s https://api.axelarscan.io/gmp/searchGMP -d '{"txHash":"<hash>"}'` — look at `status`,
  `simplified_status`, and `is_insufficient_fee`.

**For a two-hop message (any egress, EVM → XRPL), the top-level `txHash` query only shows the
first hop (source → Axelar hub).** To check the second hop (hub → destination), read the
`executed.childMessageIDs` field from that first response, then query `searchGMP` again with
`{"messageId": "<that child id>"}`. This is the mistake that caused the §5.1 failure to look
briefly like a success before it was properly checked.

**Reserve arithmetic**, needed before any Add Gas top-up: XRPL reserve = `reserve_base +
owner_count × reserve_inc` (read live via `server_state`; was `1,000,000 + 3×200,000 = 1,600,000`
drops for this account before the trust-line/other object count changed it further). Spendable =
account balance − reserve. Check this before setting `ADD_GAS_DROPS`, since a top-up request above
the spendable amount fails with `tecUNFUNDED_PAYMENT` and still costs a small fee.

**When checking a destination's own trust line state with `account_lines`, do not trust a
`peer`-filtered query alone** — it gave one false empty result in this test (§5.1). For an account
with many trust lines, paginate the full, unfiltered list (follow the `marker` field) and filter
client-side instead.

## 8. Env vars / key files (values never in this repo)

| Variable | Holds | File |
|---|---|---|
| `XRPL_TESTUSER_SEED` (mapped to `XRPL_SEED`) | XRPL Ledger account `rPAdN2a4...` seed | `.env.xrpl-testuser-mainnet` |
| `INTENT_SIGNER_PRIVATE_KEY` | Registered intent signer for that XRPL account | `.env.xrpl-testuser-signer` |

## 9. Open items

- **Recover the first 0.5 LP** (§5.4) — needs Axelar's response and action, not ours.
- **Fix the three scripts' hardcoded testnet links** (`submitXrplEnterMarket.ts`,
  `submitXrplWithdraw.ts`, used for both LP and XRP withdraws) — one-line change each, cosmetic only.
- **Decide the dApp's handling of the trust-line-limit failure mode** (§5.5) before enabling LP
  withdraw for real users. XRP withdraw does not have this risk.
- **Axelarscan's in-flight status can lag the real ledger state** (§6.2) — when a status check
  shows a message still in flight, confirm against the ledger directly before concluding anything.
- The LP's own contribution to this account's borrowing power is still small relative to the
  pre-existing `sXRP`/`sUSDC` collateral; a test that isolates the LP collateral factor at
  meaningful scale needs more LP supplied.
