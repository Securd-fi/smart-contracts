# Securd — XRPL EVM Mainnet Deployment & Live Transaction Record

Live record of the Phase 1 mainnet deployment, its post-deploy setup, and every real
transaction executed against it. This is an internal-beta deployment — see
[17-mainnet-launch-plan.md](17-mainnet-launch-plan.md) for the plan this was executed
against. Companion to the testnet equivalent,
[xrpl-evm-testnet-deployment.md](xrpl-evm-testnet-deployment.md).

**No private keys or XRPL seeds are recorded in this document.** Every address below is
public on-chain data. Signing keys used during this work are kept in local, gitignored
files only (listed in §7) — several were shared in a chat session during setup and must be
treated as permanently compromised; do not reuse them for anything beyond this beta (see
§8).

## 1. Deployment (2026-09-15)

| Role | Address |
|---|---|
| Deployer (transient, gas-only) | `0xd0f3C1504e483F5E1A9A1046Fd8cD5ED733770A2` |
| DEPLOY_OWNER (final admin/owner everywhere) | `0x57eb9411CA49752994b81cd1B60c3917Cb99247C` |
| Pause guardian / borrow-cap guardian | `0xd91A48d784B377b62dCc2963dAB219E547b4c0AE` |

Deployed via `npm run deploy:full-stack` (`scripts/deploySecurdStack.ts`) against
`config/securd-markets-mainnet-phase1.json`. Deployment record:
`deployments/xrpl-evm-mainnet.json`. Total gas cost: **0.0219 XRP** (deployer balance
2.4842 → 2.4623 XRP), 62 transactions.

### Core contracts

| Contract | Address |
|---|---|
| Unitroller (Comptroller proxy) | `0xf2631D04bf1E568c777e822213040785B968405E` |
| Comptroller implementation | `0x97E1Ad3F5ddAe9eD340f159DdAA005799107610A` |
| CollateralFactorTimelock (Unitroller admin) | `0xEB27E14a7E7Dd1652FBC6220df56F28a6b1047Fb` |
| SecurdPriceOracle | `0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98` |
| CErc20Delegate (shared implementation) | `0xC63caB9Ae6F2C9763c996392C65A390588322afd` |
| SecurdLiquidationKeeper | `0xB46013E32E4010E62e7FCF88f083191d6D8A226f` |
| XRPLUserProxyFactory | `0x06B219Afe66EB4A2508D1c0F1ab4102d5cF776fA` |
| XRPLSecurdBridgeAdapter | `0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848` |
| Shared placeholder IRM (deploy-time only, superseded — see §2) | `0xa79ED7ED42C920A77a4d297d86BA21fA4347b8e6` |

Admin chain verified live, no residual deployer access anywhere: Comptroller admin =
Timelock, Timelock owner = DEPLOY_OWNER, every cToken `admin` = DEPLOY_OWNER, every
ownable contract's `owner` = DEPLOY_OWNER.

### Markets (Phase 1)

| Symbol | cToken | Underlying | CF | Borrow cap | Oracle |
|---|---|---|---|---|---|
| sXRP | `0xEFedd95eFdB71652bd93F58b2B7F77748Dee04F6` | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` (native XRP precompile) | 75% | 2,800,000 XRP | BAND (XRP/USD) |
| sUSDC | `0x21Da09A16d69757C0731De3b83e65061BCF30E00` | `0xa16148c6Ac9EDe0D82f0c52899e22a575284f131` | 80% | 40,000 USDC | BAND (USDC/USD) |
| smXRP | `0xAf0be979e1B842B4C53Ed10fE81991D92be5B32E` | `0x06e0B0F1A644Bb9881f675Ef266CeC15a63a3d47` | 60% | 0 (by design) | FALLBACK |
| sXRPUSDCLP | `0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F` | `0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53` | **0%** (see §6) | 0 | FALLBACK |
| sXRPARMYLP | `0x48C2A0cA5a2780199ADd81BB7828612314Ae1728` | `0xD66b43e8a145e3b9e2d7e0F12f28255CB647Db7e` | **0%** (see §6) | 0 | FALLBACK |

Global: close factor 50%, liquidation incentive 10%.

## 2. Risk parameters applied (2026-09-17)

Ran via `scripts/applyMarketRiskParameters.ts`, signed by `DEPLOY_OWNER`. Hit and fixed a
real XRPL EVM gas-estimation bug along the way (see §6) — the script now uses a fixed
500,000 gas limit for `_setInterestRateModel`/`_setReserveFactor` instead of a
percentage-padded `eth_estimateGas` result.

| Symbol | Reserve factor | Active IRM | Kink |
|---|---|---|---|
| sXRP | 20% | `0xe632d65491df298D6beef22dB0d95aB3651F92ee` | 80% |
| sUSDC | 20% | `0xB0dF44Fe42aeAf78d7aE4b99246F6a98654f7364` | 90% |
| smXRP | 20% | `0x4D9865E0D8273DCD637f197215F87a622461DC0C` | 80% (inert, borrowCap=0) |
| sXRPUSDCLP | 0% | `0x3baeAbD74CEA6D7A0c14a99f1147BA576F3b22ED` | 80% (inert, borrowCap=0) |
| sXRPARMYLP | 0% | `0x530977B11c1b4e0B397ebBE11EB02cE8b48D5877` | 80% (inert, borrowCap=0) |

All 5 confirmed correct via independent on-chain read after application.

**Orphaned contracts (harmless):** two earlier `JumpRateModelV2` deployments for sXRP
failed to fully apply due to the gas-estimation bug before it was fixed —
`0x5a5F04956A14D09891075D36bf534f663F83Cc1c` and
`0x864664bcAD4EAC06E6734ED8406B2021E9633426` were deployed and briefly assigned but are
no longer referenced by any market. No functional impact, just unused bytecode on-chain.

## 3. Bridge trust & intent-signer setup (2026-09-17)

Deployment deliberately shipped with **zero** trusted GMP/ITS sources (explicit choice at
deploy time). Configured afterward for the live test, all signed by `DEPLOY_OWNER`:

| Action | Value | Tx |
|---|---|---|
| `setTrustedGmpSource` | chain=`xrpl`, address=`rPAdN2a4qHwVoFG8b6mthGeqo5UfMHjNTp` | `0xf94d97385e40c67bf4b8cda87f8fb65209d3dcbb2de0f66c2d6a8a6f741ee791` |
| `setTrustedItsSource` | chain=`xrpl`, address=utf8(`rPAdN2a4qHwVoFG8b6mthGeqo5UfMHjNTp`) | `0x495177069aa85d87d53bd6ef0761150c4060d20d95c1bb4559ef6c339d036e25` |
| `setIntentSigner` | xrplAccount=keccak256(`rPAdN2a4qHwVoFG8b6mthGeqo5UfMHjNTp`), signer=`0x200Ac4adc56C04EBb69be67484404eefECe4D06B` | `0x03fd3abb66b874bb3603d5113606c714c626d75e60b604ef5a6a953772d0efa4` |

**Important finding (confirmed via Axelarscan, not assumed):** for messages originating on
XRPL Ledger, Axelar reports `sourceAddress` as the *original sending XRPL account*, not a
shared relay account — trust is per-sender. Documented in
[xrpl-to-xrpl-evm-bridge-guide.md](xrpl-to-xrpl-evm-bridge-guide.md) Rule 2, confirmed
correct by this test. Each new XRPL account that wants to use the bridge needs its own
`setTrustedGmpSource`/`setTrustedItsSource`/`setIntentSigner` entries.

## 4. Test accounts

| Role | Address | Notes |
|---|---|---|
| XRPL Ledger test user (borrower/depositor/lender) | `rPAdN2a4qHwVoFG8b6mthGeqo5UfMHjNTp` | Funded by user with real XRP across several top-ups. Holds ~3.33 XRP, **0.75 Circle-USDC** (unusable for bridging into `sUSDC`, 0.5 lost to §5.4's stuck attempt), and **0.02 USDC.axl** (0.15 acquired in §5.4b, 0.1 stuck per §5.4c, 0.03 successfully supplied per §5.4d). |
| XRPL Ledger trusted-relay placeholder | `rh47kNvQiwh52a32U2ndk9pEZPJEXcyLwc` | Generated during config prep, **unused/unfunded** — not wired into any active trusted-source entry |
| Intent-signer EVM key | `0x200Ac4adc56C04EBb69be67484404eefECe4D06B` | Pure off-chain signing key, holds no funds, never submits its own transactions |

**Real USDC IOU on XRPL Ledger mainnet** (used for §5.4): currency `USDC`
(`5553444300000000000000000000000000000000` hex), issuer `rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE`.
Confirmed live via `gateway_balances` (4,327,799+ USDC in circulation) and cross-referenced
against three independent docs already in this repo
([securd-asset-listing-risk-parameters.md](securd-asset-listing-risk-parameters.md),
[securd-lp-leverage-delta-neutral-strategy-spec.md](securd-lp-leverage-delta-neutral-strategy-spec.md),
[xrpl-amm-collateral-analysis.md](xrpl-amm-collateral-analysis.md)) — this is **not** the
same account as the Axelar gateway (`rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`); don't conflate
the two.

Axelar mainnet infrastructure used: XRPL gateway `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`
(confirmed live, 1.58M+ XRP balance), destination chain name `xrpl-evm`, ITS
`0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C`.

## 5. Live transaction log

### 5.1 SUPPLY — 1 XRP deposit (sXRP), by test user

| Step | Chain | Tx | Result |
|---|---|---|---|
| 1. XRPL Payment (SUPPLY intent, `gas_fee_amount=0`) | XRPL Ledger mainnet | `E283923D44C0E4DB8DD019EAEEE1F69A075A54A919BE0CE51917EFA82B7215BB` | `tesSUCCESS`, but stuck on Axelar (`is_insufficient_fee: true`) |
| 2. Add Gas top-up (0.8 XRP) | XRPL Ledger mainnet | `DFC54EAD4917B1A0B9FBE752197E088BEBDF69F7168D8F88DE4B8D541F3E63C0` | `tesSUCCESS`, unblocked the stuck message |
| 3. Final delivery (`executeWithInterchainToken`, `mint`) | XRPL EVM (via Axelar) | hub tx `205357d91727b5b67059338a37a87b6d0594546e16333c58944609bca9a9858a` | Executed — confirmed via live `totalSupply`/`balanceOf` reads, not just Axelar's status flag |

**Outcome (independently verified on-chain):** sXRP cash = 1.0 XRP, exchange rate 1e18,
user's proxy auto-deployed at `0x0d563E8170e6f2972fD580c7588c726007dcbf6e`, holding the
full minted balance.

**Lesson learned:** our own docs claimed `gas_fee_amount=0` is correct for native XRP
SUPPLY on the basis that "gas is handled separately by ITS." That was wrong (or no longer
accurate) for this mainnet route — the message needed a manual Add Gas top-up, and the
0.8 XRP sent was an uninformed, overcautious guess (Axelar's own fee computation for this
exact route came back at ~0.00856 XRP once properly queried afterward — see
`scripts/estimateXrplBridgeGasFee.ts` below, roughly 1% of what was actually paid). Needs
a doc correction in `docs/xrpl-lending-execution-guide.md`.

**Gas fee estimation tooling added afterward:** `scripts/estimateXrplBridgeGasFee.ts`
(`npm run xrpl:estimate-bridge-gas`) queries Axelar's own public
`POST /gmp/estimateGasFeeForNHops` endpoint directly for the `xrpl -> axelar -> xrpl-evm`
route — the same endpoint `@axelar-network/axelarjs-sdk`'s `estimateMultihopFee` calls
internally, replicated as a single zero-dependency HTTP call rather than adding that SDK
as a dependency (its `npm install` reported 24 vulnerabilities, 1 critical, from bundled
transitive deps, all avoidable since fee computation needs no signing/wallet logic of its
own). Applies a configurable safety multiplier (default 3x) on top of the raw estimate,
since the gap between Axelar's computed estimate and the live relayer network's actual
acceptance threshold hasn't been independently measured — use this before every future
bridge transaction instead of guessing.

### 5.2 Partial WITHDRAW — 0.3 XRP, by test user

Prerequisite fixed first: `egressGasValue` was still at the untested 1 XRP deploy-time
default, and the adapter held 0 native XRP (would have reverted at the `_egress()` step's
`interchainTransfer{value: egressGasValue}` call). Re-estimated properly for the reverse
direction (`xrpl-evm -> axelar -> xrpl`, raw ~0.22 XRP) and set to a conservative
**0.35 XRP**, funded from the deployer.

| Action | Tx |
|---|---|
| `setEgressGasValue(0.35 XRP)` | `0x61bef8ff0d93f7830d04b26f5dbe772ce418f8abdf3e77c4d278d67c7d39d4d0` |
| Fund adapter (0.35 XRP) | `0xaf692cb1b5b2be823cf5b5e8ab9b44f906a46a22d37739ab5ce1b60c7a6d050e` |
| XRPL Payment (WITHDRAW intent, `gas_fee_amount`=30,000 drops — from `scripts/estimateXrplBridgeGasFee.ts`, not a guess) | `E0E2FB00F0FECEEC02A5E772F0B58CAF169B25A447C14F11661191F36BEA5735` |

**Outcome (independently verified on both chains):**
- sXRP totalSupply/cash/proxy balance: 1.0 → **0.7 XRP** (matches 0.3 XRP withdrawn)
- Adapter native balance: 0.35 → 0.0 XRP (egress gas fully consumed, no shortfall)
- Test user's XRPL Ledger balance: 1.199996 → 1.469984 XRP — reconciles exactly
  (-0.030012 payment+fee, +0.300000 returned withdrawal)
- **`is_insufficient_fee=false` from the first check** — the properly-estimated gas worked
  correctly, no Add Gas top-up needed this time. Total round-trip cost ≈ 0.03 XRP vs. the
  ~1.8 XRP the deposit test consumed.

### 5.3 USDC trustline + XRP→USDC swap, by test user

To seed `sUSDC` liquidity, the test user needed real USDC on XRPL Ledger first. Rather
than the user sourcing it externally, both steps were done directly against XRPL
Ledger's native DEX/AMM using the test account's own (small) XRP balance.

| Action | Tx | Result |
|---|---|---|
| `TrustSet` to USDC (currency/issuer above) | `B7530C2002AC13A23DB0BFF0F27CDF041BBFFA1B3E27A46303C4D57245C8DB03` | `tesSUCCESS` — trustline confirmed open via `account_lines` before sending anything |
| Cross-currency `Payment` (self-payment, XRP→USDC via native DEX/AMM, `SendMax`=1,000,000 drops hard cap, `Amount`=1.25 USDC) | `2D26960910FE263397F927FF86B972A248E42576C48DFE0F997F87D0AD0E205E` | `tesSUCCESS`, `delivered_amount`=1.25 USDC exactly |

Pool used: native XRP/USDC AMM on XRPL Ledger (same USDC issuer), reserves at the time
~234,572 XRP / ~306,027 USDC, trading fee 202 bps (2.02%) — checked live via `amm_info`
before sizing the trade, not assumed.

**Result (independently verified via `account_info`/`account_lines`):** XRP balance
4.469982 → 3.50989 (≈0.96 XRP spent, under the 1 XRP cap), USDC balance 0 → **1.25 USDC**.

### 5.4 USDC SUPPLY attempt — FAILED, funds stuck (2026-09-17)

Attempted to supply 0.5 of the 1.25 USDC into `sUSDC` via the bridge, following the same
IOU-transfer pattern as the STST test scripts. This failed and the funds are currently
stuck in Axelar's cross-chain custody — documented in full for anyone continuing this
work.

| Action | Tx |
|---|---|
| XRPL Payment (SUPPLY intent, IOU, `gas_fee_amount`=0) | `7C52A40470F00D123920603A98005DDED6B7A475BF9EAD11F09A07D4F25CBC58` |
| Add Gas top-up (30,000 drops, from the estimator) | `F2C8E42316576451ACC064338E2F32A4F956D14D6C6687314D1081B96917A06D` |
| Final XRPL EVM execution attempt | child message `0xcc7775e8...` — **failed: `EstimationReverted`** |

**Root cause (verified directly against the contract, not inferred):** the XRPL USDC IOU
issuer used (`rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE` — real, actively traded, sourced from our
own docs and confirmed live via `gateway_balances`) is a **different bridge registration**
than the one `sUSDC`'s underlying token actually uses:

| | `sUSDC`'s real underlying | What was actually bridged |
|---|---|---|
| EVM address | `0xa16148c6Ac9EDe0D82f0c52899e22a575284f131` | `0xDaF4556169c4F3f2231d8ab7BC8772Ddb7D4c84C` ("USDC.xrpl") |
| Decimals | 6 | 15 |
| tokenId | `0xaab70a74fae5d4d70134970cc0a7a03ff70bfffd5891f79d2f4daf1b5fade846` (self-reported by the token contract — confirmed correct) | `0x73c6c46c441ee16932b99375a35d2d42c5a41054b86901fb86e285d6b9128154` |
| Type | `NATIVE_INTERCHAIN_TOKEN` (ITS-native, `implementationType`=0) | different registration |

`XRPLSecurdBridgeAdapter.executeWithInterchainToken` checks `cfg.tokenId == tokenId`
(among other things) — since the delivered tokenId never matches, the call reverts. The
signed intent envelope is immutable once submitted, so **this specific message can never
be retried or corrected** — not automatically, not manually.

**Funds status:** confirmed via `account_lines` — the 0.5 USDC left the XRPL Ledger
account (1.25 → 0.75 USDC, irreversible on that side) and is **not** in the bridge adapter
(confirmed 0 balance). It is held by the Axelar gateway account on XRPL in an
undeliverable state.

**RESOLVED (2026-10-01) — permanently unrecoverable, confirmed by Axelar and
independently proven against our own contract.** Asked Axelar directly; their answer
(quoted, lightly trimmed):

> No refund mechanism exists for this message. The 0.5 USDC is held by the gateway
> account on XRPL, and the message is approved on XRPL EVM. Because your memo included
> a payload, ITS calls `executeWithInterchainToken` on your contract, which reverts on
> the tokenId check. ITS has no path to redirect, cancel or refund an approved message.
> The approval does not expire, so if your contract can ever be made to accept this tx,
> anyone can execute it and the funds are delivered.

That last sentence raised an obvious question — could the adapter ever be reconfigured
(e.g. temporarily listing the wrong token `0xDaF4556169c4F3f2231d8ab7BC8772Ddb7D4c84C`
as a market) to let this specific approved message through and recover the value as that
other token? Checked by decoding the actual signed payload still sitting on Axelar
(`messageId 0x7c52a404...`, via `axelarscan.io/gmp` raw `call.returnValues.payload`):
the envelope's `market` field is `0x21Da09A16d69757C0731De3b83e65061BCF30E00` (the real
sUSDC cToken) and its `underlying` field is `0xa16148c6Ac9EDe0D82f0c52899e22a575284f131`
(the real sUSDC underlying) — both cryptographically fixed by the original signature, and
neither is the wrong token. `amount` decodes to `500000` (0.5 USDC at 6 decimals) — the
original attempt's amount scaling was correct; only the issuer/token was wrong.

`XRPLSecurdBridgeAdapter` runs two checks against the *same* `cfg.underlying` value, read
fresh from `marketConfigOf[envelope.market]` at execution time: `_validateEnvelopeBase`
requires `cfg.underlying == envelope.underlying` (the real sUSDC address, fixed in the
signature), and `executeWithInterchainToken` requires `cfg.underlying == token` (the
wrong token actually delivered by ITS). Since `envelope.underlying` and the delivered
`token` are different, fixed addresses, no value of `cfg.underlying` can satisfy both
checks at once — **no market reconfiguration, past or future, can ever make this
specific message executable.** Axelar's caution was correct as a general statement about
approved ITS messages; for this particular stuck message our own contract's dual
consistency check rules it out. Conclusion: the 0.5 USDC is a permanent, bounded loss,
not an open risk — no one (including us) can ever extract it, and no further action is
needed on this message.

**Also resolved — Q1/Q2 (correct USDC route), officially confirmed by Axelar:**

> TokenId `0xaab70a74...` is registered on the XRPL side. The XRPL asset that delivers
> into it is: Issuer `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` (the Axelar gateway account
> itself), Currency `USDC.axl` (hex `555344432E61786C000000000000000000000000`),
> Decimals 6 on both XRPL and XRPL EVM.

This is an **official confirmation**, independent of and matching exactly what we found
ourselves via Strobe Finance's public docs (§5.4b) and then proved empirically with the
real 0.03 USDC.axl supply in §5.4d. No longer just empirically inferred — now
Axelar-confirmed on both the issuer/currency and the decimals convention.

**Also resolved — Q4 (is the Payment-with-memos pattern valid for a
NATIVE_INTERCHAIN_TOKEN specifically):**

> Your Payment-with-memos pattern is correct and works for any token type. The token
> manager type on the destination (native interchain token, lock/unlock, etc.) is
> irrelevant to the XRPL side. What determines the delivered tokenId is only the XRPL
> asset (issuer + currency) you pay into the gateway.

Confirms the same inbound mechanism (XRPL `Payment` to the gateway, `type=interchain_transfer`
memos) is universal across token manager types — nothing token-type-specific needs to
change for future markets regardless of whether they're `NATIVE_INTERCHAIN_TOKEN` or
`LOCK_UNLOCK`.

### 5.4b Finding the correct USDC bridge route (self-directed research)

Following the failure in §5.4, researched the correct XRPL-side USDC representation by
cross-checking a comparable live production protocol on XRPL EVM (Strobe Finance) that
uses the same Axelar infrastructure, rather than guessing again. Found that **two
distinct XRPL Ledger "USDC" tokens exist**, bridging to two different XRPL EVM tokens:

| | Circle USDC (used in §5.3/§5.4 — wrong for bridging) | USDC.axl (correct) |
|---|---|---|
| Currency | `USDC` (`5553444300000000000000000000000000000000`) | `USDC.axl` (`555344432E61786C000000000000000000000000`) |
| Issuer | `rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE` | `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` (the Axelar gateway account itself) |
| Bridges to | `0xDaF4556169c4F3f2231d8ab7BC8772Ddb7D4c84C` ("USDC.xrpl", 15 decimals, auto-created) | `0xa16148c6Ac9EDe0D82f0c52899e22a575284f131` (our real `sUSDC` underlying, 6 decimals, pre-registered) |

Corroborated independently before risking funds: `gateway_balances` showed the Axelar
gateway issuing 9,056.07 USDC.axl in circulation; `amm_info` showed a live XRP/USDC.axl
AMM pool (75.3 XRP / 97.7 USDC.axl, 99bps fee).

| Action | Tx | Result |
|---|---|---|
| `TrustSet` to USDC.axl (currency/issuer above) | `02AA0DEB8047E5B6C92A96796CF98F57DBBDF1966F2A62C695C8A3B677F8B1FD` | `tesSUCCESS` |
| Cross-currency `Payment` (XRP→USDC.axl via native DEX/AMM) | `D8A2A60F0A3B27D74546C31098C251764253C3C254BD737040371C1D35A741B4` | `tesSUCCESS` — acquired 0.15 USDC.axl |

### 5.4c Second SUPPLY attempt — also failed, smaller amount stuck

Tested with a much smaller amount (0.1 USDC.axl) before committing more. Token identity
resolved **correctly** this time (`tokenId` delivered matched `sUSDC`'s real
`0xaab70a74...` exactly, confirming the issuer fix worked) — but the intent envelope's
`amount` was still wrong: signed as `parseUnits("0.1", 15) = 100000000000000`
(carrying over the 15-decimal figure observed for the *wrong* token in §5.4), while
Axelar actually delivered `amount = 100000 = parseUnits("0.1", 6)`, matching the real
token's true 6 decimals.

| Action | Tx |
|---|---|
| XRPL Payment (SUPPLY intent, IOU, wrong 15-decimal envelope amount) | `159FD21927998DB645199E12B107BB87C6E88862B8467A447BC307C551E70FD8` |

**Root cause:** for a pre-registered ITS `NATIVE_INTERCHAIN_TOKEN` (our real `sUSDC`),
Axelar rescales the XRPL-side IOU amount to the *destination token's own real decimals*
(6) — not a fixed 15-decimal XRPL-source convention. That 15-decimal figure only applied
to §5.4's auto-created, unregistered token. Same immutable-envelope problem as §5.4: no
Add Gas top-up was sent for this message (would have guaranteed an `AmountMismatch`
revert for no benefit), so it was left unrelayed. 0.1 USDC.axl left the XRPL Ledger
account (0.15 → 0.05) with the same undeliverable-custody status as §5.4's 0.5 USDC.

### 5.4d Corrected SUPPLY — SUCCESS (2026-09-17)

Rebuilt the envelope with the now-confirmed-correct convention
(`amount = ethers.parseUnits(value, 6)`) in a new dedicated script,
`scripts/submitXrplUsdcSupply.ts`. Used a conservative 0.03 USDC.axl (leaving margin
from the remaining 0.05 balance) before trusting the fix at larger amounts.

| Action | Chain | Tx | Result |
|---|---|---|---|
| XRPL Payment (SUPPLY intent, IOU, `gas_fee_amount=0`, envelope amount=30,000 = `parseUnits("0.03", 6)`) | XRPL Ledger mainnet | `3CECC2F06B878D496B6E9ED4131F50EAB55386FC5B6E40B10E56A09332C3217F` | `tesSUCCESS`, stuck on Axelar (`is_insufficient_fee: true`) |
| Add Gas top-up (30,000 drops, from `scripts/estimateXrplBridgeGasFee.ts`; sent via new `scripts/sendXrplAddGasTopup.ts`) | XRPL Ledger mainnet | `9EC38DA48803F57E034E205EB82B8A78B2CE1B2DB555B9038CF538C036321FAB` | `tesSUCCESS`, unblocked the message |
| Final delivery (`executeWithInterchainToken`, mint + supply) | XRPL EVM mainnet | `0xfbeef0c585b727c4ced112c295ea03b54d9aeb267cf9ca46dca5f3bf4684dd10` | `status: 1` (success) |

**Outcome (independently verified on-chain, not just Axelar's status flag):** `sUSDC`
market cash: 0 → **30,000 raw units (0.03 USDC)**. Test user's proxy
(`0x0d563E8170e6f2972fD580c7588c726007dcbf6e`) `sUSDC` cToken balance: 0 → **30,000**
(1:1 exchange rate, as expected from `initialExchangeRateMantissa=1e18`). `sUSDC` now has
real liquidity for the first time — unblocks §5.5.

**Confirmed decimal convention for all future USDC.axl bridge transactions:**
`envelope.amount = ethers.parseUnits(xrplIouValue, 6)`. Documented here so it's never
re-derived from scratch or re-guessed.

### 5.5 Enter market, borrow USDC, repay — SUCCESS (2026-09-17)

Completed the full lending cycle against the test user's 0.7 XRP collateral. Prerequisite:
adapter's egress gas balance was fully drained by the earlier WITHDRAW (§5.2), so
re-funded before BORROW (which also carries an egress leg to deliver the borrowed USDC
back to XRPL Ledger).

| Action | Chain | Tx | Result |
|---|---|---|---|
| Fund adapter (0.35 XRP, egress gas for BORROW) | XRPL EVM mainnet | `0x6cd70c0d25397dc5cfb1808f3b34e86351547d67e978d265f1a6da38405a4957` | `status: 1` |
| ENTER_MARKET intent (sXRP, GMP `call_contract`) | XRPL Ledger mainnet | `CE1C45919738ABBD31C743A2B19F0DC616D55927D053540DEE537D28855071A9` | `tesSUCCESS`, relayed without a top-up |
| BORROW intent (0.01 USDC, GMP `call_contract`) | XRPL Ledger mainnet | `3049AA44F75B08EAF5E187C988AFCF34B5D7AE85F44FC76A862CFE1552722298` | `tesSUCCESS`, relayed without a top-up |
| Borrow execution + egress | XRPL EVM mainnet | `0x87f828b9d314e66af492bd15c50ba996f9817cdeba89c5489dec2e26cbb999d7` | `status: 1` |
| REPAY intent (0.01 USDC, ITS `interchain_transfer`, `gas_fee_amount=0`) | XRPL Ledger mainnet | `D68591A7C66BE503EE1182C310D91D819CC8945F7A82FD29061B57AE888A8B30` | `tesSUCCESS`, stuck (`is_insufficient_fee: true` on both hops) |
| Add Gas top-up (30,000 drops) | XRPL Ledger mainnet | `8F644D6F963690F1D981180956528FFE1CEE1270260483692DB4E75611D4E200` | `tesSUCCESS`, unblocked both hops |
| Repay execution | XRPL EVM mainnet | `0xd99acce534f5f2b83f828c22c8be37c403f85da190fe9788bdd2a222446806d3` | `status: 1` |

New corrected scripts used (mirroring `submitXrplUsdcSupply.ts`'s 6-decimal fix, since the
existing `submitXrplBorrow.ts`/`submitXrplRepay.ts` hardcode 18-decimal `parseEther`,
correct only for native XRP): `scripts/submitXrplUsdcBorrow.ts`,
`scripts/submitXrplUsdcRepay.ts`. Also added `scripts/sendXrplAddGasTopup.ts`, a small
reusable Add Gas helper (previously done ad hoc per script).

**Repay amount note:** repaid exactly 0.01 USDC (the known principal, `envelope.amount =
amount` matched exactly) rather than a rounded-up buffer — `CToken.repayBorrowFresh`
computes `accountBorrowsNew = accountBorrowsPrev - actualRepayAmount` with **no
`repayAll` sentinel used here**, so overpaying above the true outstanding debt underflows
and reverts the whole call (verified by reading `contracts/core/CToken.sol` directly
before submitting, not assumed). At these amounts and this time window, accrued interest
between signing and execution was too small to register at 6-decimal precision, so an
exact-match repay was safe; a `repayAll` (`amount = type(uint256).max`) sentinel exists in
the adapter for cases where that's not true.

**Outcome (independently verified on-chain):** proxy's `sUSDC` `borrowBalanceStored`: 0 →
10,000 (0.01 USDC borrowed) → **0** (fully repaid). `sUSDC` market cash: 30,000 → 20,000 →
**30,000** (restored). Test user's XRPL Ledger USDC.axl balance: 0.02 → 0.03 (borrowed
funds delivered back) → spent on repay. **Full lending cycle proven end-to-end on
mainnet: supply XRP collateral → enter market → borrow USDC → repay USDC → debt
cleared**, alongside the earlier supply/partial-withdraw cycle for XRP itself (§5.1–§5.2)
and the USDC liquidity-seeding fix (§5.4d).

## 6. Findings from this work (see also the earlier senior-auditor review)

- **LP markets' collateral factor silently failed to apply at deploy time.**
  `sXRPUSDCLP`/`sXRPARMYLP` show CF=0% instead of the configured 57%/35%. Root cause:
  `Comptroller._setCollateralFactor` returns an error code instead of reverting on
  failure; at deploy time their oracle price was 0 (LP pricing deliberately deferred), so
  the call silently no-opped. Fix: once a real LP price is posted, re-call
  `_setCollateralFactor` through the 48h timelock.
- **smXRP's fallback price is stale.** Posted once at deploy time (bootstrap
  $1.432542), 15-minute freshness window, oracle bot never started. Currently reads 0,
  which blocks redeem/borrow for any account that enters it as collateral (not just
  reduced value — `PRICE_ERROR` propagates across the whole account). Do not let real
  testers touch smXRP as collateral until this is refreshed.
- **XRPL EVM gas estimation is unreliable for calls touching `accrueInterest()`'s
  underlying `balanceOf()` on the native-XRP precompile.** `eth_estimateGas` returned
  63,306 for a `_setReserveFactor` call; the real call reverted out-of-gas twice even with
  a 50%-padded estimate (both attempts used ~99% of whatever limit was given, scaling with
  the limit rather than reflecting real cost). A fixed 500,000 gas limit worked
  (actual usage: 250,000). Patched into `applyMarketRiskParameters.ts`.
- **Native-XRP `gas_fee_amount=0` is insufficient for real relay execution on
  mainnet**, despite doc guidance saying otherwise (see §5.1).
- **Two distinct "USDC" tokens exist on XRPL Ledger mainnet, only one of which bridges to
  our `sUSDC` market** (see §5.4b). Always use USDC.axl (issuer = the Axelar gateway
  account itself), never Circle's native USDC, for anything touching `sUSDC`.
- **Axelar's XRPL→XRPL-EVM amount scaling depends on the destination token's
  registration**, not a fixed XRPL-source convention (see §5.4c/§5.4d). A pre-registered
  `NATIVE_INTERCHAIN_TOKEN` (like our real `sUSDC` underlying) rescales the XRPL IOU value
  to that token's own real decimals (6 for USDC). An auto-created, unregistered token
  (like §5.4's wrong "USDC.xrpl") instead defaults to a 15-decimal XRPL-native
  convention. These are easy to conflate — confirmed both empirically, from real delivered
  amounts, not from documentation.
- **Signed intent envelopes are cryptographically immutable.** Any mismatch discovered
  after submission (wrong token, wrong amount) cannot be corrected — the funds are
  effectively stuck pending Axelar-side recovery, with no self-service recovery path found
  via public APIs. This makes catching mismatches *before* submission the only real
  defense; small test amounts are what kept the cost of two real mistakes this session low
  (0.5 USDC and 0.1 USDC.axl).

## 7. Local secret files (gitignored, never committed, not reproduced here)

| File | Contents |
|---|---|
| `.env.mainnet` | Deployer key + full deploy config used for the original deployment |
| `.env.mainnet.owner-key` | `DEPLOY_OWNER` signing key — **currently kept on disk per explicit user instruction** (previously deleted after each use; see §8) |
| `.env.xrpl-relay-mainnet` | Seed for the unused trusted-relay placeholder account |
| `.env.xrpl-testuser-mainnet` | Seed for the live XRPL test user (`rPAdN2a...`) |
| `.env.xrpl-testuser-signer` | Private key for the intent-signer EVM key |

## 8. Security notes

- `DEPLOYER_PRIVATE_KEY` (for `0xd0f3C15...70A2`) and `DEPLOY_OWNER`'s private key (for
  `0x57eb9411CA...`) were both pasted in plaintext into a chat session during this work
  and must be treated as **permanently compromised**, regardless of what's stored where
  locally now. The deployer's exposure is lower-consequence (transient, no lasting
  privilege). `DEPLOY_OWNER`'s is more serious — it holds permanent admin control over the
  entire protocol (Comptroller via the timelock, oracle, every cToken, bridge adapter,
  liquidation keeper).
- **Before any public/non-internal launch:** rotate `DEPLOY_OWNER` to a fresh address that
  has never been shared in any chat — ideally a real multisig, not a single EOA. Every
  ownable contract here supports `transferOwnership`/`_setPendingAdmin`, so this migration
  is mechanical whenever it's time to do it.
- This deployment is explicitly an **internal beta** — not a public launch. Treat all
  balances, trust configuration, and the single-EOA `DEPLOY_OWNER` accordingly.
