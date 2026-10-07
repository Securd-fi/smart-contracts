# XRP/USDC LP Collateral Test — Full Transaction Log

All transactions below are on mainnet: XRPL EVM (chain ID `1440000`, explorer
`https://explorer.xrplevm.org`) and XRPL Ledger (`https://livenet.xrpl.org`). Dates are UTC.

**Key contracts:** Comptroller `0xf2631D04bf1E568c777e822213040785B968405E`, oracle
`0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98`, collateral-factor timelock
`0xEB27E14a7E7Dd1652FBC6220df56F28a6b1047Fb`, bridge adapter
`0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848`, `sXRPUSDCLP`
`0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F`, `sUSDC` `0x21Da09A16d69757C0731De3b83e65061BCF30E00`,
`sXRP` `0xEFedd95eFdB71652bd93F58b2B7F77748Dee04F6`.

**Two test wallets used:**
- EVM test wallet `0xd0f3C1504e483F5E1A9A1046Fd8cD5ED733770A2` — called the contracts directly.
- XRPL Ledger test account `rPAdN2a4qHwVoFG8b6mthGeqo5UfMHjNTp` (EVM bridge proxy
  `0x0d563E8170e6f2972fD580c7588c726007dcbf6e`) — real dApp-user path, through Axelar.

---

## 1. Setup — guardian actions (2026-10-06)

Sent by the pause/borrow-cap guardian `0xd91A48d784B377b62dCc2963dAB219E547b4c0AE`, using
[scripts/runGuardianPauses.ts](../scripts/runGuardianPauses.ts) and
[scripts/runGuardianBorrowCaps.ts](../scripts/runGuardianBorrowCaps.ts).

| # | Action | Tx | Block |
|---|---|---|---|
| 1.1 | Fund guardian (0.02 XRP from deployer wallet) | `0xfb3f40c13154f01776ef9f9dc0a9348ac295788cd64fd0f6e92687d50b245f75` | — |
| 1.2 | `_setBorrowPaused(sXRPUSDCLP, true)` | `0x47e45abcbb2ad5d4cb08030c48cd92f3badb8966177c7d4cd78a88ed2fa76f48` | 8011931 |
| 1.3 | `_setBorrowPaused(sXRPARMYLP, true)` | `0xdf19b39680d3abba71b923fc836feed54a2d76bc24862fa1546bae1a222ebf45` | 8011932 |
| 1.4 | `_setMintPaused(sXRPARMYLP, true)` | `0xcccc4a863732e3fa92b132394761a5154dec17d9b4ec0492191a6c7db4ec39e5` | 8011933 |
| 1.5 | `_setMarketBorrowCaps([sUSDC, sXRP], [2000 USDC, 1000 XRP])` | `0x56bb681f20169938e0f7cd2501967c95e44a5f8dc53e1c52572e86f1704a3f8a` | 8012111 |

LP mint was intentionally left open (not paused), since the first LP test deposit was already in place.

## 2. Collateral deposit — EVM wallet (2026-10-05)

From `0xd0f3C1504e483F5E1A9A1046Fd8cD5ED733770A2`, direct contract calls, 0.001 LP.

| # | Action | Tx |
|---|---|---|
| 2.1 | `approve(sXRPUSDCLP, 0.001 LP)` on the LP token | `0xbbce49d1e880f75acd470cf13469f96ef281dd262214298e900e8d04bf33bb96` |
| 2.2 | `mint(0.001 LP)` on `sXRPUSDCLP` | `0x9d2347db1c0b7c5054d85d9997483a1541730d0dbdd52c2dd5617298d34f7a2b` |
| 2.3 | `enterMarkets([sXRPUSDCLP])` | `0xbde94ddde8abddb3299247ebf757c8f1eb7eca687a8815e406ecc7c0255a4864` |

## 3. Collateral factor — set to 35% (2026-10-07)

Queued earlier through the timelock (eta `2026-10-07 11:34:11 UTC`, action id
`0xec8f338772b22bdaf0df1ed0aa305a9e00974d18c57a990f3de4c74eaecae9bb`). Executed by the owner using
[scripts/runOwnerExecuteCollateralFactor.ts](../scripts/runOwnerExecuteCollateralFactor.ts).

| # | Action | Tx | Block | Time (UTC) |
|---|---|---|---|---|
| 3.1 | `execute(actionId)` — `_setCollateralFactor(sXRPUSDCLP, 0.35e18)` | `0x817d68a29bae5ab70641a6602c80f89882507354216dde03c99364102159c63e` | 8033828 | 2026-10-07 11:49:56 |

Result verified: `markets(sXRPUSDCLP)` → `(true, 350000000000000000, false)`.

## 4. First borrow/repay — proof of mechanism, dust-sized (2026-10-07)

From `0xd0f3...`, against only the 0.001 LP (liquidity ≈ $0.0000007 — too small for any USDC unit).
Used [scripts/runRepayXrpBorrow.ts](../scripts/runRepayXrpBorrow.ts) for the repay.

| # | Action | Tx |
|---|---|---|
| 4.1 | `borrow(239807181186 wei)` on `sXRP` (≈0.00000024 XRP, 50% of liquidity ceiling) | `0x9ef9565a90dc22262e637a5f49b81df6484fe8d1b35c35fbf20247e2e93175b3` |
| 4.2 | `approve(sXRP, 239807181186)` on the native XRP precompile | `0xb5d3265ed940d83469afd46211b81c3a634f24f9adeaf33f4b165961e1e65ff4` |
| 4.3 | `repayBorrow(239807181186)` on `sXRP` | `0x788f829924a6f87edef6f4e497990e5206415d03e1f891187da6b4ed9d4a7d7a` |

This proved the mechanism end-to-end (deposit → CF → borrow → repay) but was economically negligible.

## 5. USDC borrow/repay — meaningful size, via EVM wallet's existing XRP (2026-10-07)

The wallet already held unused native XRP and was already entered in `sXRP` (CF 75%, from an
earlier, separate test). Supplying some of it pushed liquidity from $0.0000007 to $0.0217, enough
for a real 0.01 USDC borrow.

| # | Action | Tx |
|---|---|---|
| 5.1 | `approve(sXRP, 0.02 XRP)` on the native XRP precompile | `0xee8b33a94316fb418daaca9211b30082ab529a05921f52e7b72b0c42c8cb18ba` |
| 5.2 | `mint(0.02 XRP)` on `sXRP` (additional collateral) | `0x090d6cc6c3148a0fabe211b98ffa745d3550931517ca1e2d5cfdaf563fd414f6` |
| 5.3 | `borrow(10000)` on `sUSDC` (0.01 USDC) | `0x30fda004faf4edd52327aa7ddd62bb8c790e02bee945b851d5c333adce75e198` |
| 5.4 | `approve(sUSDC, 10000)` on USDC | `0x9028f3ca8fde5563d6a701f5bdeccf179de804a70ca020c201053819cc7e9186` |
| 5.5 | `repayBorrow(10000)` on `sUSDC` | `0x76b6cc49efbd0c3b5a0af18ea4066a1c74a0a5e7ae6fe8e72bfc88c295ad5e7c` |

**Caveat:** this borrow was collateralized mainly by the added XRP, not by the LP token itself. It
proves market mechanics (caps, cash limits, borrow/repay), not the LP collateral factor at scale.

## 6. Real dApp-user path — XRPL Ledger through Axelar (2026-10-07)

From the XRPL Ledger account `rPAdN2a4qHwVoFG8b6mthGeqo5UfMHjNTp`, through the bridge adapter's
intent path, exactly as a real dApp user would. This is the first time the LP SUPPLY intent path was
proven live (previously unverified — see `docs/dapp-xrp-usdc-lp-test-flow-plan.md` §6).

### 6.1 LP supply (1 LP, via `scripts/submitXrplLpSupply.ts`)

| # | Action | Tx / id |
|---|---|---|
| 6.1.1 | XRPL Payment, SUPPLY intent, 1 LP | `9D62BCBC1B7A0CE1D023A212D0AD3075DB253293E38D8AE43A67654088D03A9A` |
| 6.1.2 | Add Gas top-up (30,000 drops) — first hop was underfunded | `940E39B3B3E3059E7192D42B33A34830EE6FF5DBEC2F3379F5245310496D17DF` |
| 6.1.3 | EVM execution (mint into `sXRPUSDCLP` for the proxy) | `0xb7eb1c33107fca45afdf2e0d111b5e8e616e31170410a5362181a1f17e19c774` (block 8034275) |

Result: proxy `0x0d563E8170e6f2972fD580c7588c726007dcbf6e` LP cToken balance `1000000000000000` (1 LP).
XRPL-side LP trustline dropped from 273.56043972 to 272.56043972.

### 6.2 USDC borrow (0.01 USDC, GMP, via `scripts/submitXrplUsdcBorrow.ts`)

| # | Action | Tx / id |
|---|---|---|
| 6.2.1 | XRPL Payment, BORROW intent (GMP call_contract, native-XRP gas = 30,000 drops) | `69A3DA82544B185C42AB3F07EAD5C3A6A7AE9B674FB4254CE99017D297998266` |
| 6.2.2 | EVM execution (borrow + ITS egress back to XRPL) | `0x9af4d7e3a8c774efdc1b03b1c0310bdd5b892c5a84d4c1f1ebf17021546a4576` (block 8034351) |

Result: proxy's `sUSDC` borrow balance `10000` (0.01 USDC). Egress confirmed by the XRPL USDC.axl
trustline rising from 0.02 to 0.03.

### 6.3 USDC repay (0.01 USDC, ITS, via `scripts/submitXrplUsdcRepay.ts`)

| # | Action | Tx / id |
|---|---|---|
| 6.3.1 | XRPL Payment, REPAY intent, 0.01 USDC.axl | `DC41EE1878A02C3FD4DF573719816595DC1982F114E71F345788D4E1978A6D5E` |
| 6.3.2 | Add Gas top-up attempt, 30,000 drops — **failed**, `tecUNFUNDED_PAYMENT` (account had only ~11,155 drops spendable above reserve) | `6269D01B30ECF87C092696F6CC8D694887D241E6224855F5AF6F95E5CB052211` |
| 6.3.3 | Add Gas top-up, 10,000 drops — succeeded | `FB894961549F109141A8C1E6A4E6A0C4469E16702D803405B00B8A82A7C73874` |

Result: proxy's `sUSDC` borrow balance back to `0`. Liquidity restored to ≈$0.782.

### 6.4 XRP leg — not completed

The XRPL Ledger account is now down to **~1,143 drops (0.0011 XRP) spendable** above its reserve —
not enough to fund any further Axelar gas (10,000–30,000 drops needed per message). Supply, borrow,
or repay of XRP through this same real path needs the account funded with more XRP first. No XRP
leg was sent through Axelar in this round; the only XRP borrow/repay done was the EVM-direct one in
§4/§5.

---

## 7. Scripts used

**Written this session** (all refuse to run without an explicit confirm flag, and verify the
result on-chain after sending):

| Script | Purpose |
|---|---|
| [scripts/runGuardianPauses.ts](../scripts/runGuardianPauses.ts) | The three guardian pause calls (§1.2–1.4). |
| [scripts/runGuardianBorrowCaps.ts](../scripts/runGuardianBorrowCaps.ts) | The borrow-cap call (§1.5). |
| [scripts/computeXrplLpPriceDryRun.ts](../scripts/computeXrplLpPriceDryRun.ts) | Read-only LP price and guard check, no key needed. |
| [scripts/submitXrplLpSupply.ts](../scripts/submitXrplLpSupply.ts) | LP SUPPLY intent from an XRPL wallet (§6.1). |
| [scripts/runOwnerExecuteCollateralFactor.ts](../scripts/runOwnerExecuteCollateralFactor.ts) | Collateral-factor execution (§3). |
| [scripts/runRepayXrpBorrow.ts](../scripts/runRepayXrpBorrow.ts) | XRP repay helper (§4.2–4.3). |

**Existing repo scripts reused:**

| Script | Purpose |
|---|---|
| `scripts/submitXrplUsdcBorrow.ts` | USDC BORROW intent, GMP (§6.2). |
| `scripts/submitXrplUsdcRepay.ts` | USDC REPAY intent, ITS (§6.3). |
| `scripts/sendXrplAddGasTopup.ts` | Add Gas top-up for an underfunded Axelar message (§6.1.2, §6.3.2–3). |

## 8. Key env vars used (values stay in local, gitignored files — never in this repo)

| Variable | Holds | File |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | EVM test wallet `0xd0f3...` key | `.env.mainnet` |
| `OWNER_PRIVATE_KEY` | Timelock/protocol owner key | `.env.mainnet.owner-exec-key` |
| `GUARDIAN_PRIVATE_KEY` | Pause/borrow-cap guardian key | `.env.mainnet.guardian-key` |
| `XRPL_TESTUSER_SEED` (mapped to `XRPL_SEED`) | XRPL Ledger account `rPAdN2a4...` seed | `.env.xrpl-testuser-mainnet` |
| `INTENT_SIGNER_PRIVATE_KEY` | Registered intent signer for that XRPL account | `.env.xrpl-testuser-signer` |

## 9. Open items

- Fund `rPAdN2a4qHwVoFG8b6mthGeqo5UfMHjNTp` with more XRP to complete the XRP leg via Axelar.
- The LP's own contribution to borrowing power is still tiny (~$0.0007 per LP at current price);
  a meaningful LP-only borrow test needs several LP, not 0.001–1.
- Formula, guards, and publishing-status items are tracked separately in
  `docs/lp-price-calculation-spec.md`.
