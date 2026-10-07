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

**Status: LP and USDC done. XRP not done** — see §4.

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

## 4. XRP — not completed

No XRP transaction (supply, borrow, or repay) was sent through Axelar from this XRPL Ledger account
in this round. **Blocker:** after the top-ups above, the account has only **~1,143 drops
(0.0011 XRP) spendable** above its reserve. Every message in §1–§3 needed 10,000–30,000 drops of
gas; there is nothing left to fund another one.

**To unblock:** send real XRP (5–10 XRP is a reasonable margin) on the XRPL Ledger to
`rPAdN2a4qHwVoFG8b6mthGeqo5UfMHjNTp` from an account you control there. No script here can
create that XRP — it has to come from outside this test's existing funds.

Once funded, the XRP leg would use the same pattern as §2/§3 (a GMP borrow, an ITS supply/repay,
each possibly needing an Add Gas top-up the first time), with the native-18-decimal scripts
(`submitXrplDeposit.ts` for supply, `submitXrplBorrow.ts`/`submitXrplRepay.ts` for borrow/repay —
not the `*Usdc*` variants, which hardcode 6-decimal scaling).

## 5. Scripts reference

| Script | Action | Key env vars | Confirm flag |
|---|---|---|---|
| [scripts/submitXrplLpSupply.ts](../scripts/submitXrplLpSupply.ts) | LP SUPPLY, ITS | `XRPL_SEED`, `INTENT_SIGNER_PRIVATE_KEY`, `XRPL_LP_SUPPLY_AMOUNT` | `XRPL_CONFIRM_SEND=true` |
| `scripts/submitXrplUsdcBorrow.ts` | USDC BORROW, GMP | `XRPL_SEED`, `DEPLOYER_PRIVATE_KEY` (= intent signer key here), `XRPL_USDC_BORROW_AMOUNT` | `XRPL_CONFIRM_SEND=true` |
| `scripts/submitXrplUsdcRepay.ts` | USDC REPAY, ITS | `XRPL_SEED`, `INTENT_SIGNER_PRIVATE_KEY`, `XRPL_USDC_REPAY_AMOUNT` | `XRPL_CONFIRM_SEND=true` |
| `scripts/sendXrplAddGasTopup.ts` | Gas top-up for an underfunded Axelar message | `XRPL_SEED`, `ADD_GAS_MSG_ID`, `ADD_GAS_DROPS` | none — sends on invocation, so check `ADD_GAS_DROPS` against spendable balance first |

**All four are dry-run safe by default** (`submitXrpl*`: no `XRPL_CONFIRM_SEND` → prints the
envelope and the Payment, sends nothing; `sendXrplAddGasTopup.ts` has no dry-run mode, so check
the account's spendable balance before setting `ADD_GAS_DROPS`).

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
  `simplified_status`, and `is_insufficient_fee`. For an egress (EVM → XRPL) leg, search using the
  **EVM execution tx hash**, not the original XRPL one.

**Reserve arithmetic**, needed before any Add Gas top-up: XRPL reserve = `reserve_base +
owner_count × reserve_inc` (read live via `server_state`; was `1,000,000 + 3×200,000 = 1,600,000`
drops for this account). Spendable = account balance − reserve. Check this before setting
`ADD_GAS_DROPS`, since a top-up request above the spendable amount fails with
`tecUNFUNDED_PAYMENT` and still costs a small fee.

## 6. Env vars / key files (values never in this repo)

| Variable | Holds | File |
|---|---|---|
| `XRPL_TESTUSER_SEED` (mapped to `XRPL_SEED`) | XRPL Ledger account `rPAdN2a4...` seed | `.env.xrpl-testuser-mainnet` |
| `INTENT_SIGNER_PRIVATE_KEY` | Registered intent signer for that XRPL account | `.env.xrpl-testuser-signer` |

## 7. Open items

- Fund `rPAdN2a4qHwVoFG8b6mthGeqo5UfMHjNTp` with more XRP to run the XRP leg (§4).
- The LP's own contribution to this account's borrowing power is still small (1 LP ≈ $0.002); a
  test that isolates the LP collateral factor at meaningful scale needs more LP supplied.
