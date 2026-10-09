# Securd — Mainnet dApp Integration: Review, Closure Plan and Test Protocols

Response to the dApp developer's first mainnet implementation report.
Companion to [xrpl-evm-mainnet-dapp-developer-guide.md](xrpl-evm-mainnet-dapp-developer-guide.md)
(addresses, executed transactions, scripts) and
[xrpl-evm-mainnet-deployment.md](xrpl-evm-mainnet-deployment.md) (deployment record).

**Ground rule for this plan at the time it was written: no new or modified smart contracts.** Every fix below originally used
only the already-deployed contracts (existing owner-only setters, the timelock, the oracle), dApp code, and operations.

**Superseded update (2026-10-01):** that ground rule was revisited and the limitation in §2.4 was closed. A narrow
registrar contract (`XRPLAdapterRegistrarGate`) has been built, audited (3 independent passes), and deployed to mainnet —
full detail, including the audit findings and live on-chain verification, in
[xrpl-evm-mainnet-deployment.md](xrpl-evm-mainnet-deployment.md) §3b. §2 below is kept as-is for the historical record of
why batch registration (Option C) was the interim answer, but it is no longer the live onboarding path — new wallets are
now registered via `gate.registerAccount(xrplAddress)`, called by the dApp's own server key (now the gate's `registrar`),
not by the owner key directly.

## 0. Scope, sources, method

**Reviewed:** the developer's report (two launch-blocking findings + four code bugs); the dApp repo, branch `mainnet`
(`pr1mer-tech/Securd`, head `f59cde3`): `app/api/register-user`, `app/api/sign-intent`, `lib/xrpl/{types,xrplPayment,intentBuilder,useSubmitIntent,useAxelarStatus}.ts`,
`lib/constants/{network,markets,contracts}.ts`, `components/markets/{SupplyModal,BorrowModal,ContractDataSync}.tsx`; the live mainnet contracts
(read from `https://rpc.xrplevm.org`); and the six real transactions we executed.

**Not available / not reviewed:** the developer's numbered task list and written questions (only the report text was provided); his tests;
his local `.env.local`; and these dApp parts, which I did not read: `walletContext`, `useMarketsData`, `usePendingIntentWatcher`, the snapshot indexer, the Squid bridge and
advanced-strategies flows. Nothing was run against the dApp UI. Section 12 lists what this review does **not** establish.

**Tags:** CONFIRMED · CONFIRMED + WORSE · NEW (not in his report) · NEEDS TEST (cannot be settled by reading; a canary protocol is in §9).
**Severity:** P0 blocks launch or can lose user funds · P1 fix before public users · P2 should fix.

## 1. Executive summary

| # | Item | Verdict | Sev. | Closure |
|---|---|---|---|---|
| 1 | Onboarding impossible (owner-only registration) | CONFIRMED | P0 | §2 — batch pre-registration by the owner key |
| 2 | Adapter egress reserve empty (0.0 XRP) | CONFIRMED | P0 | §3 — fund + lower `egressGasValue` + monitor |
| 3 | XRPL gateway defaults to testnet | CONFIRMED | P0 | §4.1 |
| 4 | Market without XRPL identity treated as native XRP | CONFIRMED + WORSE | P0 | §4.2 |
| 5 | Repay MAX = debt × 1.005 reverts | CONFIRMED | P0 | §4.3 |
| 6 | `register-user` result ignored | CONFIRMED | P1 | §4.4 |
| 7 | Gas constants 40–100× too high; in-kind gas untested | NEW | P1 | §5.1, §9 (G1, G2) |
| 8 | Stuck-message recovery missing (nonce reuse strands funds) | NEW | P0 | §5.2 |
| 9 | No pre-flight checks before the user pays | NEW | P1 | §5.3 |
| 10 | `sign-intent` hardening gaps | NEW | P1 | §5.4 |
| 11 | XRPL/EVM RPC failure handling | NEW | P1 | §5.5 |
| 12 | 3 of 5 markets unusable at launch | NEW | P0 (gating) | §6 |
| 13 | Key hygiene and rotation | NEW | P1 | §7 |
| G1–G6 | Open gaps needing live evidence | NEEDS TEST | — | §9 |

His diagnoses are correct. Items 1–2 need owner-key and ops actions, items 3–6 and 8–11 are dApp fixes, item 12 is dApp gating plus owner-key
actions, and the gaps close with the small canary protocols in §9. The flow he needs is already proven on mainnet (§8.2).

## 2. Finding 1 — Onboarding fails on mainnet

### 2.1 Verified facts
- `setIntentSigner`, `setTrustedItsSource`, `setTrustedGmpSource` are `onlyOwner` on `XRPLSecurdBridgeAdapter` (source lines 143–191).
- Live `owner()` of adapter, factory, oracle, keeper and timelock is `0x57eb9411CA49752994b81cd1B60c3917Cb99247C` (cold `DEPLOY_OWNER`).
  His route signs with a hot key, so each call reverts `Ownable: caller is not the owner`. Correct.
- Registration is per XRPL account because Axelar reports the **original XRPL sender** as `sourceAddress`. Keep this: it means the hot signer key alone can never
  move funds; a message must also originate from the user's own XRPL account.
- The factory freezes its controller once any proxy exists (`setController` reverts `ControllerFrozen` when `proxyCount != 0`; live `proxyCount = 1`),
  so the adapter cannot simply be swapped for another.

### 2.2 Options within the no-new-contracts rule

| Option | Description | Verdict |
|---|---|---|
| **C. Batch pre-registration by the owner key** | Owner key (or multisig) sends the three existing calls per approved wallet. | **Recommended** |
| D. Give the hot key ownership | — | **Rejected:** it would control pausing, market listing, `withdrawNative`, `rescueERC20`, nonce reset. |
| E. Online owner-key service | The owner key lives in a KMS/HSM behind a policy service that signs only the three registration selectors. | Not recommended: an online key that is also the protocol owner. Only acceptable with hardware-enforced selector policy and rate limits, and it still concentrates risk. |

### 2.3 Closure steps (Option C)
1. **Developer** provides (a) the approved wallet list (`wallets.json`, XRPL classic addresses) and (b) the **public address** of the backend intent signer `S` (§7).
2. **Owner-key operator** runs, per wallet `a`, only for what is not yet set:
   ```ts
   const xrplAccount = ethers.keccak256(ethers.toUtf8Bytes(a));              // keccak256(utf8(address))
   const itsId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string","bytes"], ["xrpl", ethers.toUtf8Bytes(a)]));
   const gmpId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string","string"], ["xrpl", a]));
   if ((await adapter.intentSignerOfXrplAccount(xrplAccount)) === ethers.ZeroAddress) await (await adapter.setIntentSigner(xrplAccount, S)).wait();
   if (!(await adapter.trustedItsSource(itsId))) await (await adapter.setTrustedItsSource("xrpl", ethers.toUtf8Bytes(a), true)).wait();
   if (!(await adapter.trustedGmpSource(gmpId))) await (await adapter.setTrustedGmpSource("xrpl", a, true)).wait();
   ```
   (`string` and `bytes` ABI-encode identically, so the dApp's single `sourceKey` works for both maps. This is the same sequence already used for the test account.)
3. Use a fixed gas limit (500 000) on each send: XRPL EVM `eth_estimateGas` is unreliable here (deployment doc §6). Cost is negligible (62 deployment transactions cost ≈0.02 XRP).
4. **Acceptance:** for every wallet all three reads return set; then one canary supply from that wallet (§10 step 4).
5. **Cadence:** batch daily (or per beta cohort). The dApp shows "awaiting approval" until the three reads are true (§4.4).

### 2.4 Limitation (for the team's decision, not proposed here)
Without a contract change, onboarding is **allowlisted and batched**; it cannot be instant and self-service. This is acceptable for a closed beta. For an open public launch the team
would have to decide later between accepting batched onboarding, or a contract-level change to the registration authority. That decision, and any contract work, is out of scope for this plan.

### 2.5 dApp-side hardening of the registration endpoint (independent of the above)
The route is unauthenticated and spends gas per address. Once registration is owner-batched, **remove the on-chain write from the route entirely**: turn it into
(a) `POST /api/request-access` (stores the address in a DB, with the same rate limits) and (b) `GET /api/registration-status?address=` (reads the three on-chain values).
This removes the hot-key gas-drain risk and makes the failing `Ownable` call disappear.

## 3. Finding 2 — Adapter egress reserve is empty

### 3.1 Verified facts
- Adapter native balance **1.6 XRP** as of 2026-10-01 (funded via tx `0xeb06682a3b1bc15d1ebc3024f32ebd9be682c2ea88fc309d3a098f606129de73`, sent from XRPL EVM native, not from an XRPL Ledger `r...` address — was 0.0 XRP before). `egressGasValue = 0.35 XRP`.
  This covers ≈4-5 borrow/withdraw actions, not the full N=20 target below — the remaining ≈5.4 XRP is still needed.
- `_egress()` calls `interchainTransfer{value: egressGasValue}` from the adapter's own balance on every `BORROW` and `WITHDRAW`; the full value is forwarded whatever the real cost.
  Observed: 0.35 → 0 on each execution (our test drained it).
- Axelar's estimate for the reverse route (`xrpl-evm → axelar → xrpl`, queried today): `totalFee = 222 473 851 199 999 999` wei ≈ **0.2225 XRP** — about 36% below 0.35.
- If the reserve is short, `_egress` reverts and the whole EVM transaction reverts atomically (no state change), but the user has already paid the XRPL-side payment.

### 3.2 Closure steps
1. **Set the value:** run the estimate, then `egressGasValue = ceil(estimate × 1.25)` ≈ **0.28 XRP**.
   ```bash
   curl -s -X POST https://api.axelarscan.io/gmp/estimateGasFeeForNHops -H 'Content-Type: application/json' \
     -d '{"params":[{"sourceChain":"xrpl-evm","destinationChain":"axelar","gasLimit":"0"},{"sourceChain":"axelar","destinationChain":"xrpl","gasLimit":"0"}],"showDetailedFees":false}'
   ```
   Owner call: `adapter.setEgressGasValue(280000000000000000)`. Re-run weekly and whenever the alert fires (the fee moves with gas and XRP price).
2. **Fund the float:** N × `egressGasValue` with N = 20 → **5.6 XRP** total, by a plain native transfer to `0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848` (mechanism proven twice: `0x6cd70c0d…4957` and `0xeb06682a…9de73`).
   **1.6 XRP of this has been sent** (2026-10-01, tx `0xeb06682a3b1bc15d1ebc3024f32ebd9be682c2ea88fc309d3a098f606129de73`, drained the deployer to ≈0.06 XRP). **≈5.4 XRP still needed** from the treasury to reach the full float.
3. **Monitor:** `remaining = floor(getBalance(adapter) / egressGasValue)`; page at `< 5`; the dApp pre-flight disables Borrow/Withdraw at `< 1` (§5.3).
4. **Acceptance:** after funding, one tiny borrow and one tiny withdraw succeed, and the adapter balance drops by **exactly** `egressGasValue` per action (delta assertion).
5. Excess gas is not returned; see G6 in §9.

## 4. Code bugs in the report — verified, with fixes

### 4.1 XRPL gateway defaults to testnet (CONFIRMED, P0)
Evidence: `lib/xrpl/types.ts:31` uses `NEXT_PUBLIC_XRPL_AXELAR_GATEWAY ?? "rNrjh1KGZk2jBR3wPfAQnoidtFFYQKbQn2"` with no `IS_MAINNET` branch. On mainnet the payment goes to the wrong
account and never bridges.
```ts
const MAINNET_GATEWAY = "rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw";
const TESTNET_GATEWAY = "rNrjh1KGZk2jBR3wPfAQnoidtFFYQKbQn2";
export const XRPL_AXELAR_GATEWAY =
  process.env.NEXT_PUBLIC_XRPL_AXELAR_GATEWAY ?? (IS_MAINNET ? MAINNET_GATEWAY : TESTNET_GATEWAY);
if (IS_MAINNET && XRPL_AXELAR_GATEWAY !== MAINNET_GATEWAY) throw new Error("Mainnet chain with non-mainnet Axelar gateway");
if (!IS_MAINNET && XRPL_AXELAR_GATEWAY === MAINNET_GATEWAY) throw new Error("Testnet chain with mainnet Axelar gateway");
```
`NEXT_PUBLIC_*` values are inlined at build time, so also assert the pairing in `next.config.mjs` (fail the build) and in a CI step on the deploy environment.
**Tests:** (mainnet + default → mainnet gateway), (mainnet + testnet gateway → throws), (testnet + mainnet gateway → throws). **Done when** the three tests pass and a mainnet build with the testnet gateway fails.

### 4.2 IOU market with no XRPL identity treated as native XRP (CONFIRMED + WORSE, P0)
Evidence: `MARKET_METADATA` in `lib/constants/markets.ts` contains only the testnet sSTST cToken; on mainnet `marketIou()` returns `undefined`, so `useSubmitIntent`
takes the native branch and sends native XRP with an envelope for another underlying.
```ts
const isNative = (u: string) => u.toLowerCase() === NATIVE_UNDERLYING.toLowerCase();
// in useSubmitIntent, before building anything:
if (!isNative(params.underlying) && !params.iou) throw new Error("Market has no XRPL identity; not supported from XRPL");
```
Mainnet identities to add (key = lowercase cToken):

| Market | cToken | XRPL currency | XRPL issuer | Decimals |
|---|---|---|---|---|
| sXRP | `0xefedd95efdb71652bd93f58b2b7f77748dee04f6` | native | — | drops ×1e12 |
| sUSDC | `0x21da09a16d69757c0731de3b83e65061bcf30e00` | `555344432E61786C000000000000000000000000` (USDC.axl) | `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` | **6** |
| sXRPUSDCLP | `0xbc08f8e0cf29874a9c9c660cf5f045bd65f2270f` | `03B20F3A7D26D33C6DA3503E5CCE3E67B102D4D2` | `rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE` | 15 (G4) |
| sXRPARMYLP | `0x48c2a0ca5a2780199add81bb7828612314ae1728` | `037C2A57B0011520DE389E332043EC0FAF858ACE` | `rnsRq5ahgbFeRiAgBVvFTafyAgiS9x9Ztn` | 15 (G4) |
| smXRP | `0xaf0be979e1b842b4c53ed10fe81991d92be5b32e` | none identified | — | — |

- sUSDC must be **USDC.axl (issuer = the gateway)**, never Circle USDC (`rGm7…`, which bridges to a different token; funds unrecoverable). `rGm7…` in `lib/strategies/advancedStrategies.ts` is correct only for the AMM planner.
- smXRP's ITS token manager is `LOCK_UNLOCK` (type 2, verified on-chain), i.e. EVM-originated; no XRPL representation was found, so it is not supplyable from XRPL.
- LP entries stay **disabled** until §6 is closed and G4 is done.
- Envelope amount = `parseUnits(value, underlyingDecimals)` with decimals read from chain (`ERC20.decimals()`; 18 for native). Fix the comment in `types.ts` ("18-decimal EVM wei" is wrong for IOUs).
- **Trustline precheck** (XRPL `account_lines` with `peer = issuer`): if absent, offer a `TrustSet` first:
  `{ TransactionType:"TrustSet", Account, LimitAmount:{ currency:"555344432E61786C000000000000000000000000", issuer:"rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw", value:"1000000" } }`.
  Reserve: 1 XRP base + 0.2 XRP per trustline (current mainnet values) — show the user the reserve before proceeding.

**Tests:** `parseUnits("0.03", 6) === 30000n`; a non-native market without identity throws; sUSDC identity equals the table. **Done when** a UI supply of 0.02 USDC.axl delivers 20 000 raw units (canary, §10 step 4).

### 4.3 Repay MAX = debt × 1.005 reverts (CONFIRMED, P0)
Evidence: `BorrowModal.tsx:33` `REPAY_MAX_BUFFER = 1.005`, `:197` sets the amount to `debt × 1.005`, and that value becomes both the payment and `envelope.amount`.
`CToken.repayBorrowFresh` (lines 647–695) computes `accountBorrowsNew = accountBorrowsPrev − actualRepayAmount`; a repay above the debt underflows and reverts inside the ITS callback, so the message fails.

Fix — use the adapter's repay-all sentinel (`executeWithInterchainToken`, lines 337–343; `_repay`, 476–502):
```ts
const MAX_UINT256 = 2n ** 256n - 1n;
const BUFFER_BPS = 10n;                                   // 0.1%
const debt = await simulateBorrowBalanceCurrent(proxy);   // borrowBalanceCurrent is non-view: use simulateContract / eth_call
const carried = debt + (debt * BUFFER_BPS + 9_999n) / 10_000n;   // ceil
envelope.amount = MAX_UINT256;            // what the adapter reads (skips the exact-amount check)
paymentValue   = formatUnits(carried, decimals);          // what the XRPL payment carries
```
For native XRP repay, round `carried` up to a whole number of drops (`ceil(carriedWei / 1e12)`); the delivered amount is `drops × 1e12`.

Buffer sizing (from the deployed curves; worst case = 100% utilization): sUSDC 14.7% APR, sXRP 21% APR. Worst-case debt growth: sUSDC 0.0101% per 6 h, 0.0403% per 24 h, 0.282% per 7 d.
A 0.1% buffer covers ≥ 24 h at worst case with a 6 h TTL. If the TTL is ever extended, use `buffer ≥ 3 × worstAPR × TTLhours / 8760`.
- The market pulls exactly the current debt; the surplus stays as underlying **dust in the user's proxy** (not automatically returned). Keep the buffer small; show the user "up to X may remain in your proxy".
- If the delivered amount ends up **below** the debt at execution, the pull fails on allowance and the message reverts — so never undersize.
- Partial repay: `envelope.amount == delivered amount`, and require `carried ≤ debt` (validate against the fresh `borrowBalanceCurrent`).
- `sign-intent` allows `MAX_UINT256` **only** when `actionType === REPAY`.
- Separate the two values in code: today one `amountEvm` feeds both the envelope and the payment.

**Tests:** repay-all with debt 10 000 → envelope `MAX_UINT256`, payment 10 010 raw; partial repay above debt is rejected client- and server-side. **Done when** a UI repay-all clears the debt to exactly 0 on mainnet (canary).

### 4.4 `register-user` result ignored (CONFIRMED, P1)
Evidence: `ContractDataSync.tsx` calls `/api/register-user` in a `useEffect` and only logs failures.
Fix (consistent with §2.5): a registration state `unknown → pending_approval → registered | failed`, driven by an authoritative on-chain read:
```ts
// GET /api/registration-status?address=<r...>
const xrplAccount = keccak256(toBytes(a));
const sourceKey = keccak256(encodeAbiParameters([{type:"string"},{type:"bytes"}], ["xrpl", stringToHex(a)]));
const [signer, its, gmp] = await Promise.all([
  read("intentSignerOfXrplAccount", [xrplAccount]), read("trustedItsSource", [sourceKey]), read("trustedGmpSource", [sourceKey])]);
return { registered: signer.toLowerCase() === BACKEND_SIGNER.toLowerCase() && its && gmp };
```
Disable every action until `registered`; poll with backoff; surface "awaiting approval" instead of a silent failure. **Done when** an unregistered wallet cannot open a payment.

## 5. Additional findings (not in his report)

### 5.1 Gas constants far too high; in-kind gas untested (P1, NEEDS TEST)
`lib/xrpl/types.ts`: `ITS_GAS_FEE_DROPS = 2 XRP`, `GMP_GAS_DROPS = 3 XRP`, `ITS_IOU_GAS_FEE = 2` tokens. Measured on mainnet (Axelar estimate, 500 000 destination gas): raw ≈ 8 500 drops (0.0085 XRP);
3× ≈ 25 000–30 000 drops. Every GMP action costs 3 XRP today (≈100× the need); a USDC supply/repay would take 2 USDC.
Replace with a server route:
```ts
// app/api/estimate-gas/route.ts   (server-side; also avoids browser CORS)
const r = await fetch("https://api.axelarscan.io/gmp/estimateGasFeeForNHops", { method:"POST", headers:{ "Content-Type":"application/json" },
  body: JSON.stringify({ params:[{sourceChain:"xrpl",destinationChain:"axelar",gasLimit:"0"},{sourceChain:"axelar",destinationChain:"xrpl-evm",gasLimit:"500000"}], showDetailedFees:false }) });
const text = (await r.text()).replace(/"/g, "");   // parse as TEXT -> BigInt: the value can exceed 2^53 and JSON.parse would round it
const drops = BigInt(text) * 3n;                     // 3x safety
return Response.json({ drops: (drops < 20_000n ? 20_000n : drops).toString() });   // floor 20 000; cache ~60 s
```
(With `showDetailedFees:true` the endpoint returns an object with `totalFee`; handle both.) Where the estimate goes: GMP actions → the payment `Amount` is the whole gas (`GMP_GAS_DROPS`); ITS native → `gas_fee_amount` memo;
ITS IOU → **two-step** (below) until G1 is proven.
Two-step for IOUs (proven on mainnet): send the transfer with `gas_fee_amount = "0"`, then a top-up payment:
```ts
export function buildAddGasPayment({ xrplAddress, txHash, drops }: { xrplAddress: string; txHash: string; drops: bigint }) {
  return { TransactionType: "Payment" as const, Account: xrplAddress, Amount: drops.toString(), Destination: XRPL_AXELAR_GATEWAY,
    Memos: [ buildMemo("type", utf8Hex("add_gas")), buildMemo("msg_id", utf8Hex(txHash.toLowerCase().replace(/^0x/, ""))) ] };
}
```
Open items G1, G2 (in-kind gas) and G6 (refund of excess) are in §9.

### 5.2 Stuck messages and nonce reuse can strand funds (P0)
The adapter consumes the nonce only on **successful** execution, so a stuck message leaves it unchanged. A new intent then reuses the nonce; when the old one is later topped up it fails `InvalidNonce`, and for SUPPLY/REPAY
the tokens stay stuck at Axelar. The existing "pending" guard is an in-memory Zustand value (lost on refresh, absent across tabs/devices). On mainnet `is_insufficient_fee` is **not** self-healing (it stayed stuck until Add Gas on the source chain).

Closure — persist pending intents and enforce one open intent per account in the database (he already has Postgres):
```sql
create table pending_intents (
  id bigserial primary key,
  xrpl_address text not null, tx_hash text unique not null,
  action smallint not null, market text not null, amount_raw numeric not null, nonce bigint not null,
  status text not null check (status in ('submitted','confirming','insufficient_fee','executing','egress','done','failed','abandoned')),
  gas_topups int not null default 0, created_at timestamptz not null default now(),
  last_polled_at timestamptz, final_evm_tx text, error text);
create unique index one_open_intent_per_account on pending_intents (xrpl_address)
  where status in ('submitted','confirming','insufficient_fee','executing','egress');
```
Rules: poll Axelarscan by hash; `insufficient_fee` for > 60 s → show **"Top up gas"** (Add Gas payment for that hash, amount from §5.1, count in `gas_topups`, escalate after 2);
success only when the EVM leg executed with no error (§5.5); cross-check `nextNonceByXrplAccount`: if it advanced past the intent's nonce, the intent is `done` or superseded.
"Abandon" is allowed only for GMP intents (no funds attached); for SUPPLY/REPAY it requires a support step with an explicit warning. **Done when** a forced-stuck canary is recovered through the UI top-up and a second intent is blocked meanwhile.

### 5.3 No pre-flight checks before the user pays (P1)
Every failure after the XRPL payment costs the user gas and may strand value. Add a server-side simulation returning an actionable error **before** signing:
- Registration complete; `intentSignerOfXrplAccount == server signer`; `nonce == nextNonceByXrplAccount`.
- BORROW/WITHDRAW: `getBalance(adapter) ≥ egressGasValue` (else disable); `getCash(market) ≥ amount`; account liquidity after the action:
  ```ts
  const proxy = (await read(factory,"proxyOf",[xrplAccount])) || (await read(factory,"predictProxy",[xrplAccount]));
  const [err, liquidity, shortfall] = await read(comptroller,"getHypotheticalAccountLiquidity",[proxy, cToken, redeemCTokens, borrowRaw]);
  // require err == 0 && shortfall == 0.  redeemCTokens = ceil(amountUnderlying * 1e18 / exchangeRateStored) (cTokens are 8-dec; exchange rate is 1e18 today = 1:1 raw)
  ```
- Market gates: `mintGuardianPaused`, `borrowGuardianPaused` false; `borrowCaps` headroom (sXRP cap 2.8M XRP, sUSDC cap 40 000 USDC); price > 0.
- SUPPLY/REPAY: trustline present and IOU balance sufficient (`account_lines`); trustline reserve covered; repay ≤ debt unless sentinel.
- ENTER_MARKET before borrowing against that collateral (proven order: supply → enter market → borrow).

### 5.4 `sign-intent` hardening (P1)
The route is well built (listed-market check, destination pinned to the caller's address, action/amount shape rules). Gaps:
1. **No rate limit** (unlike `register-user`): it is an unauthenticated signing oracle — add per-IP and per-address limits and an audit log (account, market, action, amount, nonce).
2. **Client-controlled `deadline`:** override server-side. GMP intents (no funds): short TTL is a safe stale-guard. Value intents: expiry means a revert at delivery and stranded tokens, so keep a long TTL (6 h is acceptable) **only together with §5.2**.
3. Bind `nonce` to the on-chain `nextNonceByXrplAccount`; refuse stale/future values.
4. Refuse to sign for an unregistered account (the adapter would reject it and the user would pay for nothing).
5. Per-market amount bounds (min, max, decimal granularity); `MAX_UINT256` only for REPAY.
6. Trust model: `x-xrpl-address` is an unauthenticated claim. It is safe because funds can only be routed back to that same address (destination pinning) **and** the adapter requires the message to originate from the user's own XRPL account. Keep both.

### 5.5 RPC and submission failure handling (P1)
Observed during our mainnet tests: XRPL public servers returned `tooBusy` — including **after** a preliminary `tesSUCCESS` on `submitAndWait` — and `eth_getTransactionReceipt` timed out.
```ts
async function reconcile(hash: string) {                       // call after ANY submit error, before showing "failed" or allowing retry
  for (const url of XRPL_ENDPOINTS) {                          // s1/s2.ripple.com, xrplcluster.com
    try { const r = await request(url, { command: "tx", transaction: hash });
          if (r.result.validated) return r.result.meta.TransactionResult; } catch {}
  }
  return undefined;   // unknown -> keep polling until LastLedgerSequence has passed, then treat as not submitted
}
```
Rules: multiple endpoints with fallback; retry with backoff on EVM RPC; cap the XRPL fee (our scripts use 10 000 drops) and set `LastLedgerSequence`; never allow a second payment while the first is unresolved (§5.2).
**Status semantics:** success = the **EVM leg** executed with no error. ITS: the first `executed` is the Axelar hub hop; follow `childMessageIDs`. BORROW/WITHDRAW have a second leg (egress back to XRPL): mark complete only when the egress child has executed and show "funds arriving on XRPL" in between.
His `parseStatus` already prefers the child message; extend it to the egress child.

## 6. Market readiness and gating (P0)

Verified live:

| Market | Price | Collateral factor | Cash | Usable at launch |
|---|---|---|---|---|
| sXRP | > 0 (Band) | 75% | 0.7 XRP | Yes |
| sUSDC | > 0 (Band) | 80% | 0.03 USDC | Yes; liquidity tiny |
| smXRP | **0** (stale fallback) | 60% | 0 | **No** |
| sXRPUSDCLP | **0** | **0%** | 0 | **No** |
| sXRPARMYLP | **0** | **0%** | 0 | **No** |

`getAllMarkets()` returns all five (verified), so the dApp must gate them:
```ts
const enabled = ALLOWLIST.has(cToken) && price > 0n && (!asCollateral || collateralFactor > 0n) && (isNative(underlying) || hasIdentity(cToken));
```
An unpriced asset in an account's entered markets poisons the whole liquidity check (`PRICE_ERROR`), so unpriced markets must not be enterable. Cap the borrow input at `getCash`.
`NEXT_PUBLIC_MAINNET_FEATURES` defaults to **on** for chain 1440000 (Squid bridge, advanced strategies) — decide explicitly whether they ship; if not, set it to `false`.

**Closing the LP markets (owner key + ops, existing contracts only):**
1. `oracle.setAssetOracle(lpUnderlying, botWallet, true)` for both LP underlyings (owner call).
2. Run the LP oracle bot per the guide §1; the LP price must stay fresh within `fallbackMaxDelay = 900 s` or `getUnderlyingPrice` returns 0. Enable LP markets in the UI only after the bot has run continuously for an agreed soak period.
3. Confirm `oracle.getUnderlyingPrice(cToken) > 0`, then re-apply the collateral factor through the 48 h timelock:
   ```ts
   const data = comptroller.interface.encodeFunctionData("_setCollateralFactor", [cToken, 570000000000000000n]); // sXRPUSDCLP 57%; sXRPARMYLP: 350000000000000000n (35%)
   await timelock.queue(UNITROLLER, 0, data, 172800);   // delay >= MIN_DELAY (48 h); actionId = keccak256(abi.encode(target,value,data,eta)) — read it from the ActionQueued event
   // after eta and within the 7-day grace period:
   await timelock.execute(actionId);
   ```
   The timelock **reverts** (`ExecutionFailed`) on a non-zero market error code, so a price of 0 can no longer make this silently no-op as it did at deploy time; the action stays queued. Verify with `comptroller.markets(cToken).collateralFactorMantissa`.
4. XRP/ARMY additionally needs the "ARMY valued at 0" handling in the bot (guide §1.8) before any price is posted.
5. **smXRP:** there is no live feed and no XRPL identity. Recommended: keep it out of the UI (retire from the allowlist) until a proper price source exists; do not "solve" it by owner-posting prices by hand (15-minute freshness window).

Liquidity: sUSDC cash is 0.03 USDC, so the maximum borrow is ≈0.03 USDC until seeded (Squid bridge spec).

## 7. Secrets, key hygiene and rotation (P1)
- Rename `DEPLOYER_PRIVATE_KEY` to `INTENT_SIGNER_PRIVATE_KEY`. Use a fresh dedicated key in a secret manager. Never reuse the protocol deployer, `DEPLOY_OWNER`, or any key that has appeared in a chat or terminal.
  The signer used for our test account (`0x200Ac4…D06B`) belongs to that account only; treat it as compromised for production.
- With §2.5 the hot key no longer sends any transaction: it only signs intents (offline signature). It needs no gas balance.
- `CRON_SECRET`, DB strings, WalletConnect/Xumm keys stay server-only, never `NEXT_PUBLIC_*`; the public `.env.local.example` must not contain real keys.
- **Rotation runbook** (per-account signer mapping makes it O(users)): (1) pause new intents in the dApp and wait until no intent is pending; (2) the owner key runs `setIntentSigner(account, newSigner)` for every registered account
  (intents signed by the old key fail `InvalidIntentSignature` after this); (3) switch the server key; (4) run the registration-status check for all accounts; (5) resume. Schedule in a quiet window; cost ≈ N small transactions.

## 8. Mainnet configuration and reference vectors

### 8.1 Environment (public values only)
```
NEXT_PUBLIC_XRPL_EVM_CHAIN_ID=1440000
NEXT_PUBLIC_XRPL_EVM_RPC_URL=https://rpc.xrplevm.org
NEXT_PUBLIC_COMPTROLLER_ADDRESS=0xf2631D04bf1E568c777e822213040785B968405E   # Unitroller proxy
NEXT_PUBLIC_ORACLE_ADDRESS=0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98
NEXT_PUBLIC_PROXY_FACTORY_ADDRESS=0x06B219Afe66EB4A2508D1c0F1ab4102d5cF776fA
NEXT_PUBLIC_BRIDGE_ADAPTER_ADDRESS=0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848
NEXT_PUBLIC_LIQUIDATION_KEEPER_ADDRESS=0xB46013E32E4010E62e7FCF88f083191d6D8A226f
NEXT_PUBLIC_XRPL_AXELAR_GATEWAY=rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw
NEXT_PUBLIC_AXELAR_DESTINATION_CHAIN=xrpl-evm
NEXT_PUBLIC_EXPLORER_XRPL_EVM=https://explorer.xrplevm.org
NEXT_PUBLIC_EXPLORER_XRPL_LEDGER=https://livenet.xrpl.org
NEXT_PUBLIC_AXELARSCAN_URL=https://axelarscan.io
NEXT_PUBLIC_AXELARSCAN_API_URL=https://api.axelarscan.io
```
`NEXT_PUBLIC_INTEREST_RATE_MODEL_ADDRESS` must not be treated as global on mainnet (each market has its own model; the deploy-time shared model `0xa79ED7…` is superseded). His code reads `cToken.interestRateModel()` per market; keep the env value only as a fallback.

### 8.2 Reference transactions (real, mainnet) — use as test vectors
| Step | XRPL tx | Envelope amount |
|---|---|---|
| Supply 1 XRP | `E283923D44C0E4DB8DD019EAEEE1F69A075A54A919BE0CE51917EFA82B7215BB` | 1 000 000 drops × 1e12 |
| Withdraw 0.3 XRP | `E0E2FB00F0FECEEC02A5E772F0B58CAF169B25A447C14F11661191F36BEA5735` | 0.3e18 |
| Supply 0.03 USDC.axl | `3CECC2F06B878D496B6E9ED4131F50EAB55386FC5B6E40B10E56A09332C3217F` | **30 000** (6 dec) |
| Enter market (sXRP) | `CE1C45919738ABBD31C743A2B19F0DC616D55927D053540DEE537D28855071A9` | 0 |
| Borrow 0.01 USDC | `3049AA44F75B08EAF5E187C988AFCF34B5D7AE85F44FC76A862CFE1552722298` | 10 000 |
| Repay 0.01 USDC.axl | `D68591A7C66BE503EE1182C310D91D819CC8945F7A82FD29061B57AE888A8B30` | 10 000 (exact) |

Inspect at `https://axelarscan.io/gmp/<lowercase hash>` and `https://livenet.xrpl.org/transactions/<hash>`.

## 9. Closing the gaps — canary protocols

Rules for every canary: real funds, tiny amounts, one action at a time, verify on **both** chains after each step, **never retry a failed value intent** (it is not recoverable) — investigate first.
Record each result in the deployment doc §5 with hashes.

### G1 — In-kind gas for USDC.axl (IOU ITS transfer)
- **Question:** does Axelar deduct an in-token `gas_fee_amount` for USDC.axl and relay without a top-up? (STST had no in-kind price; USDC.axl is unverified.)
- **Setup:** test account with trustline and ≥ 0.10 USDC.axl; registered; `sUSDC` open.
- **Do:** Payment value `0.07` = supply `0.02` + gas `0.05` (≈4.5× the ≈$0.011 need); memo `gas_fee_amount = "0.05"`; envelope amount **20 000**; no other transaction.
- **Observe (Axelarscan, ~2 min):**
  | Result | Meaning | Decision |
  |---|---|---|
  | `is_insufficient_fee=false`, executed, delivered amount **20 000** | In-kind gas works and is deducted | Adopt in-kind, sized from the estimate |
  | `is_insufficient_fee=true` stays | In-kind unsupported | Keep the two-step flow; recover with Add Gas |
  | Executed but delivered ≠ 20 000 (e.g. 70 000) | Gas not deducted → `AmountMismatch` | Loss ceiling **0.07 USDC**; keep the two-step flow |
- **Loss ceiling:** 0.07 USDC.axl.

### G2 — In-kind gas inside a native-XRP ITS payment
- **Do:** deposit `0.1 XRP` (100 000 drops) + gas 30 000 drops → payment `Amount = 130000`, memo `gas_fee_amount = "30000"`, envelope `100000 × 1e12`.
- **Observe/decide:** same table as G1 (delivered must equal 100 000 drops). **Loss ceiling:** 0.13 XRP.

### G3 — Message failed for an empty egress reserve: can it be re-executed?
- **Why:** the adapter reserve is 0 today, so this is testable with almost no risk (a GMP intent carries no tokens).
- **Do:** with the reserve at 0, submit a BORROW of 0.01 USDC (GMP, 30 000 drops gas). Expect an EVM revert at `_egress` and a failed/re-executable message on Axelarscan.
  Fund the adapter with `egressGasValue` (§3.2), then re-execute the same message (Axelarscan "Execute", or `adapter.execute(commandId, "xrpl", sourceAddress, payload)` using the values from the message's approval record).
- **Success:** the borrow executes, the debt appears, the adapter balance drops by exactly `egressGasValue`, and 0.01 USDC.axl arrives on XRPL.
- **If re-execution is impossible:** the rule becomes "never allow BORROW/WITHDRAW with reserve `< 1`" (already enforced by §5.3), and users must re-submit.
- **Loss ceiling:** ≈0.03 XRP gas.

### G4 — LP token delivered amounts (15 decimals) — gated: only before enabling an LP market
- **Do:** acquire a tiny LP balance (`AMMDeposit` into the pool), open the trustline to the pool-issued LP currency, and bridge `0.000001` LP with the envelope computed as `parseUnits("0.000001", 15) = 1 000 000 000`.
- **Observe:** Axelarscan `interchain_transfer.amount` and `decimals` versus the envelope. **Decision:** if they match, the LP identity in §4.2 is confirmed; if not, do not enable the market and use the delivered convention. **Loss ceiling:** the tiny LP amount.

### G5 — Wallet capability (question to the developer)
Does the XRPL Connect wallet manager expose a sign-message capability? With owner-batched onboarding (§2.5) it is no longer needed for registration; it remains useful to authenticate `request-access`.

### G6 — Is excess gas refunded on the XRPL route?
- **Do:** record the account balance, send one GMP action with 30 000 drops, then watch for an incoming Payment from the gateway (or the Axelarscan `refunded`/`not_to_refund` fields) for ~10 minutes and reconcile the balance.
- **Decide:** if no refund arrives, keep the estimator multiplier at 3× (not higher) — over-estimating is a permanent cost. **Loss ceiling:** the 30 000 drops.

## 10. Sequencing, ownership, acceptance

| Step | Owner | Depends on | Done when |
|---|---|---|---|
| 1. Merge dApp fixes §4.1–4.4, §5.1–5.5 | dApp | — | The test vectors in each section pass |
| 2. Set `egressGasValue`; fund the float; add the alert | Ops + owner key | treasury transfer | balance ≥ 20 × `egressGasValue`; alert live |
| 3. Batch pre-registration (§2.3) | Owner-key operator | wallet list + signer address `S` | three reads set for every wallet |
| 4. Canary through the real UI: supply → enter market → borrow → repay-all → withdraw | Joint | 1–3 | debt = 0; balances reconcile on both chains |
| 5. G3 (empty-reserve re-execution) | Joint | 3 | protocol result recorded |
| 6. G1, G2, G6 | Joint | 4 | gas approach decided and recorded |
| 7. LP oracle bot → timelock CF → G4 → enable LP markets | Owner key + ops | bot soak | market passes the §6 gate |
| 8. Seed sUSDC liquidity | Treasury | — | cash ≥ launch target |

**Go-live checklist (all must be true):** gateway/chain assertion in CI · identity map for every enabled market · repay-all sentinel test · pending-intent table live with one-open-per-account · pre-flight active · sign-intent limits active ·
registration status endpoint live · adapter reserve funded and alerting · owner runbook for batches and rotation written · canaries recorded.

## 11. Questions back to the developer
1. Please send the numbered task list (tasks 1–3, 9b and the rest) and his written questions — this review used the report text and code only.
2. Which wallets are in the closed beta, and what is the **public address** of the backend signer `S`?
3. Should smXRP and the LP markets be hidden at launch, or shown as "coming soon"?
4. Do the Squid bridge and the advanced-strategies planner ship in the first release? They need their own review; none of that flow is covered here.
5. Which XRPL wallets must be supported, and does the manager expose sign-message (G5)?
6. Can the existing Postgres store hold `pending_intents` (§5.2)?

## 12. Self-audit of this document

**Corrections made during review**
- Removed an earlier proposal for a new registrar contract: the team rules out new contracts. Onboarding is now batch registration with the existing owner-only setters (§2).
- Egress over-provisioning corrected from "≈37%" to ≈36% (0.2225 vs 0.35 XRP), with the live estimate and a concrete `egressGasValue` (0.28 XRP) and float (5.6 XRP).
- Repay buffer changed from 0.5% to **0.1%**, with the worst-case interest arithmetic from the deployed curves and the proxy-dust consequence.
- Added the JSON-number precision warning for the Axelar estimate (values above 2^53 must be parsed as text).
- `getAllMarkets()` (5 markets), cToken decimals/exchange rates, and the borrow/pause guards were verified on-chain rather than assumed.

**What this review does not establish**
- Anything about the dApp parts listed as not reviewed in §0, or runtime behavior of the UI.
- G1–G6 outcomes: they are protocols, not results. In particular, whether excess gas is refunded, whether in-kind gas works for USDC.axl, and whether a message that failed for an empty reserve can be re-executed are **unverified**.
- The claim that a stuck-then-superseded value message strands funds is derived from the adapter's nonce logic and Axelar's retry model, not observed on mainnet.
- Design debt that would need contract changes to remove (not proposed): per-account signer rotation cost, shared egress reserve paid by the protocol, proxy dust not returned to users, and self-service onboarding.

## 13. Verification log
- Owner-only setters: `XRPLSecurdBridgeAdapter.sol` lines 143–191; live `owner()` on adapter/factory/oracle/keeper/timelock = `0x57eb9411…9247C`; factory `controller() = adapter`, `proxyCount = 1`, `setController` reverts when `proxyCount != 0`.
- Egress: live `getBalance(adapter) = 0`; `egressGasValue = 0.35 XRP`; estimate `222 473 851 199 999 999` wei; `_egress` source; observed 0.35 → 0.
- Repay: `CToken.repayBorrowFresh` lines 647–695; adapter sentinel lines 337–343, `_repay` 476–502; IRM parameters from `config/securd-market-risk-mainnet.json`; live `blocksPerYear = 9 014 400`; sUSDC `borrowRatePerBlock = 0` at zero utilization.
- Timelock: `SecurdCollateralFactorTimelock.sol` — `MIN_DELAY 48 h`, `GRACE_PERIOD 7 d`, `execute` reverts on a non-zero market return code, `actionId = keccak256(abi.encode(target, value, data, eta))`.
- dApp: `lib/xrpl/types.ts:31`, `lib/constants/markets.ts`, `lib/xrpl/useSubmitIntent.ts`, `lib/xrpl/xrplPayment.ts`, `lib/xrpl/intentBuilder.ts`, `components/markets/BorrowModal.tsx:33,197`, `components/markets/ContractDataSync.tsx`, `app/api/register-user/route.ts`, `app/api/sign-intent/route.ts`.
- Markets: live `getUnderlyingPrice`, `markets()`, `getCash()`, `borrowCaps`, guardian-paused flags, ITS `implementationType()`; `getAllMarkets().length = 5`.
