# XRP/USDC LP Collateral Test — Handoff for the dApp Developer

Written for: the dApp developer who will repeat the test steps from their own wallet and finish the remaining steps.

This document covers mainnet XRPL EVM (chain ID `1440000`, RPC `https://rpc.xrplevm.org`, explorer `https://explorer.xrplevm.org`). It describes what has been done, how to repeat each step, and what is still pending. The test is small on purpose: 0.001 LP token and 0.01 USDC.

**Do not use the deployer key or any key from the team's `.env` files.** The key that sent the transactions below is marked compromised in the team's env file. Use your own test wallet. Never put private keys or seeds in code, docs or commits.

---

## 0. What to change in the dApp

The dApp needs these changes to run the test from the UI. Each item links to the section that has the details.

1. **Market config.** Add `sXRPUSDCLP` as a collateral market: cToken and underlying LP token addresses (§1), LP token decimals 15, cToken decimals 8. Add the `sUSDC` borrow market with USDC decimals 6.
2. **LP price state.** Read `fallbackPriceOf` for the LP token (§4.1). Show three states: no price (`updatedAt` = 0), stale (older than 15 minutes), and live. Show the LP as "not available for borrowing yet" in the first two states. Do not show a number from a stale price as current.
3. **Supply flow.** Use the three calls in §2 in order: approve, mint, enterMarkets. Scale every amount by the token's decimals.
4. **Collateral state.** Read the collateral factor from `markets(sXRPUSDCLP)` (§4.2). Show "0%" as "not yet collateral" and the test factor 35% once set.
5. **Borrow flow.** Read `getAccountLiquidity` (§4.4). If it returns error `13`, show "price not available yet" and not a generic failure. Cap the borrow input at the USDC cash shown by `getCash()` on `sUSDC` (§4.3).
6. **Repay flow.** Approve USDC to `sUSDC`, then `repayBorrow`. Read the current borrow balance first, since interest may have accrued.
7. **Test banner.** Show a visible "test market, small amounts, policy waiver" note on every LP screen (§5).
8. **No keys in the dApp.** The dApp must sign with the user's own wallet only. It must not hold or read the team's keys.

Acceptance: the dApp shows the three LP price states correctly against live chain data, and the full supply, borrow and repay flow works from a user wallet once the price and collateral factor are set.

## 1. Addresses

| Item | Address |
|---|---|
| Comptroller (Unitroller proxy) | `0xf2631D04bf1E568c777e822213040785B968405E` |
| Price oracle (`SecurdPriceOracle`) | `0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98` |
| Collateral factor timelock | `0xEB27E14a7E7Dd1652FBC6220df56F28a6b1047Fb` |
| `sXRPUSDCLP` (LP collateral market) | `0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F` |
| LP token (underlying of `sXRPUSDCLP`, 15 decimals) | `0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53` |
| `sUSDC` (USDC market) | `0x21Da09A16d69757C0731De3b83e65061BCF30E00` |
| USDC underlying of `sUSDC` (6 decimals) | `0xa16148c6Ac9EDe0D82f0c52899e22a575284f131` |
| `sXRP` (XRP market) | `0xEFedd95eFdB71652bd93F58b2B7F77748Dee04F6` |
| Test account used for the completed steps | `0xd0f3C1504e483F5E1A9A1046Fd8cD5ED733770A2` (see the security note above) |

Decimals matter. The LP token has 15 decimals, so `0.001 LP = 1000000000000` raw units. USDC has 6 decimals, so `0.01 USDC = 10000` raw units. `sXRPUSDCLP` is an 8-decimal cToken. The initial exchange rate is `1e18` for every market, so one raw underlying unit mints one raw cToken unit. The mint of `1000000000000` LP raw units therefore gives a cToken balance of `1000000000000` raw, which is 10,000 cTokens when shown with 8 decimals. Use the decimals of each token when you display amounts. Do not mix them.

## 2. Completed transactions (repeat in this order)

All three succeeded on XRPL EVM mainnet (receipt status `1`, confirmed on 2026-10-05).

### 2.1 Approve the LP token to the market

- Call: `approve(address spender, uint256 amount)`, selector `0x095ea7b3`
- To: LP token `0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53`
- Arguments: spender `0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F`, amount `1000000000000`
- Tx: `0xbbce49d1e880f75acd470cf13469f96ef281dd262214298e900e8d04bf33bb96`

### 2.2 Mint the cToken (deposit the LP)

- Call: `mint(uint256 mintAmount)`, selector `0xa0712d68`
- To: `sXRPUSDCLP` `0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F`
- Arguments: `1000000000000`
- Tx: `0x9d2347db1c0b7c5054d85d9997483a1541730d0dbdd52c2dd5617298d34f7a2b`
- Result: cToken balance `1000000000000` raw. The return code is `0`.

### 2.3 Enter the market as collateral

- Call: `enterMarkets(address[] cTokens)`, selector `0xc2998238`
- To: Comptroller `0xf2631D04bf1E568c777e822213040785B968405E`
- Arguments: `["0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F"]`
- Tx: `0xbde94ddde8abddb3299247ebf757c8f1eb7eca687a8815e406ecc7c0255a4864`
- Result: `checkMembership` returns `true`.

### 2.4 Example commands (cast, Foundry)

Replace `$PK` with your own test wallet key from your own secure store. Do not paste it into chat or docs.

```bash
RPC=https://rpc.xrplevm.org
LP=0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53
CL=0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F
CT=0xf2631D04bf1E568c777e822213040785B968405E
AMT=1000000000000

cast send $LP 'approve(address,uint256)' $CL $AMT --private-key $PK --rpc-url $RPC
cast send $CL 'mint(uint256)' $AMT --private-key $PK --rpc-url $RPC
cast send $CT 'enterMarkets(address[])' "[$CL]" --private-key $PK --rpc-url $RPC
```

## 3. Current state (re-checked read-only on 2026-10-05, before the 7 October eta)

| Check | Value | Meaning |
|---|---|---|
| `sXRPUSDCLP` listed | `true` | Market exists |
| Collateral factor | `0` | LP gives no borrowing power yet |
| Mint paused | `false` | Deposits allowed |
| Borrow cap on `sXRPUSDCLP` | `0` | In this Comptroller `0` means **unlimited** borrowing (`Comptroller.sol` line 372), not zero. The LP market's 0.001 LP cash can be borrowed by anyone with other collateral once a price exists. |
| Borrow paused on `sXRPUSDCLP` | `false` | Pause guardian can set it to `true` (§4.6). Only the admin can unpause. |
| LP oracle price (`fallbackPriceOf` on the LP token) | `0`, timestamp `0` | No price posted yet |
| Bot authorised for the LP market (`isAssetOracle`) | `true` | The bot can post when it runs |
| LP staleness window (`fallbackMaxDelay`) | `900` s (15 minutes) | A price older than this is not usable |
| `getAccountLiquidity` for the test account | error `13` (`PRICE_ERROR`), liquidity `0` | Expected until the price is posted |
| Test account LP balance / cToken balance | `0` / `1000000000000` raw | The §2 deposit is in place |
| Test account membership in `sXRPUSDCLP` | `true` | §2.3 is in place |

Explain the error code if you see it: Comptroller error `13` is `PRICE_ERROR` (index 13 of the `Error` enum in `contracts/core/ErrorReporter.sol`). It means the oracle has no usable price for a market the account holds. Until the bot posts a price, the account has no liquidity to read.

## 4. Remaining steps

### 4.1 Price bot must post the LP price (blocker)

Nothing else can happen until the LP price is posted. The price is posted by the authorised bot at `0xB31864169090B6A5e57e4C41B9d953EbEd48902c` (`isAssetOracle` is true for the LP market). The bot operator runs `runXrplLpOracleBot.ts` with `config/xrpl-lp-oracle-test-xrp-usdc.json` on a machine that stays online. The publish interval in that config is 2 minutes. See `docs/dapp-lp-oracle-price-update-guide.md` for the details.

Check that the price is live:

```bash
cast call 0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98 'fallbackPriceOf(address)(uint256,uint256)' 0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53 --rpc-url https://rpc.xrplevm.org
```

You need a non-zero price and a recent timestamp. If the timestamp is more than 15 minutes old, LP collateral is unusable, which blocks borrows.

Do not post the price yourself. The owner does not post routine prices, and the bot is the only intended poster.

### 4.2 Collateral factor (owner, through the timelock)

The change `_setCollateralFactor(sXRPUSDCLP, 0.35e18)` is already queued in the collateral factor timelock.

- Action id: `0xec8f338772b22bdaf0df1ed0aa305a9e00974d18c57a990f3de4c74eaecae9bb`
- Queue tx: `0x1190165aaa6b03bcfb8eb1eeaa68852451b242fadbd6635074671f3798e0a21b`
- Earliest execution (eta): `2026-10-07 11:34 UTC` (Unix `1791372851`)
- Expires: `2026-10-14 11:34 UTC` (7-day grace period)

The timelock owner is `0x57eb9411CA49752994b81cd1B60c3917Cb99247C`. Only that key can execute, so you cannot. The owner executes this after the price is live and on or after the eta. Check the queued action before then:

```bash
cast call 0xEB27E14a7E7Dd1652FBC6220df56F28a6b1047Fb 'queuedActions(bytes32)(address,uint256,bytes,uint256,bool)' 0xec8f338772b22bdaf0df1ed0aa305a9e00974d18c57a990f3de4c74eaecae9bb --rpc-url https://rpc.xrplevm.org
```

If the price is not live at execution time, the Comptroller refuses a non-zero collateral factor for a market with no price (`PRICE_ERROR`, `contracts/core/Comptroller.sol` line 897–898). The timelock then reverts with `ExecutionFailed`, and the action stays queued. Nothing breaks.

After execution, check the collateral factor:

```bash
cast call 0xf2631D04bf1E568c777e822213040785B968405E 'markets(address)(bool,uint256,bool)' 0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F --rpc-url https://rpc.xrplevm.org
```

The second value should be `350000000000000000` (0.35e18).

### 4.3 Borrow limits on the USDC market

The borrow for this test happens on `sUSDC`, not on the LP market. The LP market's borrow cap of `0` means unlimited, so the LP market's borrow must be paused before the price goes live (§4.6).

Checked read-only on the USDC market at the time of this handoff:

- Borrow cap: `40000000000` raw (40,000 USDC), not a constraint for 0.01 USDC.
- Cash available: `30000` raw (0.03 USDC). This is the real limit. A 0.01 USDC borrow fits, a larger one does not.
- Mint and borrow pause: `false`.

Re-check cash before borrowing, since it can change:

```bash
cast call 0x21Da09A16d69757C0731De3b83e65061BCF30E00 'getCash()(uint256)' --rpc-url https://rpc.xrplevm.org
```

### 4.4 Borrow and repay 0.01 USDC

Once the price is live and the collateral factor is set, check liquidity (it should be positive), then:

1. Borrow `10000` raw units (0.01 USDC) from `sUSDC`: `borrow(uint256)`, selector `0xc5ebeaec`, to `0x21Da09A16d69757C0731De3b83e65061BCF30E00`.
2. Repay the full amount: approve USDC `0xa16148c6Ac9EDe0D82f0c52899e22a575284f131` to `sUSDC` (`approve`, `0x095ea7b3`), then `repayBorrow(uint256)`, selector `0x0e752702`, with `10000`, or the current borrow balance if interest has accrued.

Check after each step with `getAccountLiquidity(address)`, selector `0x5ec88c79`.

### 4.6 Pause borrowing on the LP market (pause guardian, before the price goes live)

The LP market holds 0.001 LP as cash, and its borrow cap is `0` (unlimited). Before the bot posts a price, the pause guardian should pause borrowing on that market:

- Call: `_setBorrowPaused(address cToken, bool state)` on the Comptroller with `state = true`
- Arguments: `0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F`, `true`
- Caller: the pause guardian `0xd91A48d784B377b62dCc2963dAB219E547b4c0AE`, or the admin.
- Must happen before `2026-10-07 11:34 UTC`, so the collateral factor can execute on time.
- Does not affect the 0.01 USDC test borrow on `sUSDC`.
- Unpausing later is admin-only, through the timelock.

The guardian runs this directly, not through the timelock. Check it afterwards with `borrowGuardianPaused(address)` on the Comptroller.

### 4.5 Optional: withdraw the LP

To take the LP back, call `redeem(uint256)` on `sXRPUSDCLP`, selector `0xdb006a75`, with your cToken balance. Do this only after the borrow is repaid and no liquidation risk is open.

## 5. Important limits

- The LP market is a test with a policy waiver. The XRP/USDC LP pool is about $37K according to the team's test-run notes (not re-measured for this doc), below the $50K production floor. Do not treat this as production collateral.
- The LP price is computed by the bot from the XRPL AMM pool reserves and the two underlying prices, with a 25% haircut. It is not an independent market price feed, so it will always sit below the live DEX value by about the haircut.
- The collateral factor is 35% for the test only.
- The ARMY LP market is out of scope. Its mint is still open. Do not interact with it for this test.
- If the bot stops, the LP price goes stale and LP collateral blocks borrowing. Watch it before borrowing.

## 6. Checklist

- [ ] Bot is running and `fallbackPriceOf` returns a non-zero, fresh price.
- [ ] Owner executes the queued collateral-factor action on or after `2026-10-07 11:34 UTC`, before `2026-10-14 11:34 UTC`.
- [ ] `markets(sXRPUSDCLP)` shows the 0.35e18 collateral factor.
- [ ] `getAccountLiquidity` returns a positive liquidity for the test account.
- [ ] Borrow `10000` (0.01 USDC) from `sUSDC`.
- [ ] Repay the borrow in full.
- [ ] Record each transaction hash in `docs/lp-collateral-test-run.md`.
