# XRP/USDC LP Collateral — Technical Test Run (mainnet, test only)

Purpose: prove that the XRP/USDC AMM LP token can be bridged to XRPL EVM and deposited as collateral
(`sXRPUSDCLP`), with a price from the AMM. This is a technical demonstration, not production collateral.

## Scope and policy exception (read first)

- **Test only.** No real users, tiny amounts from our own wallets, time-boxed to 7 days from the
  first deposit.
- **Policy exception.** `docs/15-xrpl-lp-oracle-bot.md` §8.3 requires TVL of at least $50,000 for
  production collateral. The pool is about $37K. The test config uses `minTvlUsd: 25000` for this
  test only. This is not a production waiver. Pool TVL is set by third-party liquidity providers
  and we do not control it.
- **Haircut.** 25% (2500 bps), inside the 20–35% band for thin pools in `docs/15` §7.
- **Collateral factor.** 35% for the test. Set through the timelock, see step 1 below.
- **ARMY is out of scope.** No ARMY price is published and the ARMY LP mint stays paused.

## Completed on mainnet (with transaction hashes)

1. **Collateral factor queued (XRPL EVM).** `_setCollateralFactor(sXRPUSDCLP, 0.35)` queued through
   `SecurdCollateralFactorTimelock` (`0xEB27E14a7E7Dd1652FBC6220df56F28a6b1047Fb`) with a 48-hour delay.
   Queue tx `0x1190165aaa6b03bcfb8eb1eeaa68852451b242fadbd6635074671f3798e0a21b`, action id
   `0xec8f338772b22bdaf0df1ed0aa305a9e00974d18c57a990f3de4c74eaecae9bb`. Earliest execution
   2026-10-07 11:34 UTC; grace period ends 2026-10-14 11:34 UTC.
2. **Liquidity deposit (XRPL Ledger).** Two-asset `AMMDeposit` of 0.25 XRP and 0.37 USDC into the XRP/USDC
   pool, tx `5CBF4C042A86FEBE7B3B2B56792F8391BA18BD769C3E22FFF454444A5AB298AD`. Received 273.56143972 LP.
   Amounts were reduced from the planned 1 XRP and 0.7 USDC because the account's spendable XRP after
   reserves was lower than expected.
3. **Bridge canary (XRPL Ledger → XRPL EVM), decimals verified.** 0.001 LP sent as a plain
   `interchain_transfer` (no payload), tx `C0A5F334669E2C538FEE33C7B28EDA68950891AC39FA504FF89B6FAA46C2FE9B`.
   The first hop needed a 30,000-drop Add Gas top-up (`7D35A459429793D7A42486A5109DAC491D4F22606C5106D794E6FFA31284F55A`).
   The second hop cleared on its own. Final execution `0xe1a8e85a5cee35f66b35240cbf6231790b31d5476322ce83b6369565abe1d435`.
   Delivered balance at `0xd0f3C1504e483F5E1A9A1046Fd8cD5ED733770A2`: **0.001 LP**, raw `1000000000000`,
   which confirms the 15-decimal convention. Token id `e2f2d147cc5da2f15c947b85d9a0bd88dc7e64bf864725a76b064002a06e291b`
   matches the `sXRPUSDCLP` bridge token.

   Note: one submission returned "server too busy" even though it had gone through. We confirmed on-chain
   before retrying, which avoided a duplicate payment. Always check transaction history before a retry.

## Bot configuration

`config/xrpl-lp-oracle-test-xrp-usdc.json` covers XRP/USDC only, with the test values above. It passes
`validateXrplLpOracleConfig.ts`. The publisher is the authorized bot address
`0xB31864169090B6A5e57e4C41B9d953EbEd48902c`, which is already authorized for `sXRPUSDCLP` through
`setAssetOracle` (verified via `isAssetOracle`). Its private key is held only by the bot operator.

## Remaining steps

4. **Bot publishes.** The bot operator runs `runXrplLpOracleBot.ts` with the test config and
   `LP_ORACLE_PRIVATE_KEY`, on a machine that stays online. Verify `fallbackPriceOf` on
   `0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53` shows a non-zero price with a fresh timestamp.
5. **Execute the collateral factor.** After the price is posted and before 2026-10-14 11:34 UTC,
   execute the queued action through the timelock. If no price is posted, the Comptroller returns an
   error code, the timelock reverts with `ExecutionFailed`, and the action stays queued (safe).
6. **Deposit as collateral.** Approve the 0.001 LP from `0xd0f3C1504e483F5E1A9A1046Fd8cD5ED733770A2`,
   call `mint` on `sXRPUSDCLP` (`0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F`), then `enterMarkets`
   on the Comptroller. Verify the account liquidity reflects the LP value.
7. **Optional borrow test.** Borrow 0.01 USDC against the LP, then repay. Borrow size is limited by the
   USDC cash on `sUSDC` (0.03 USDC).

## What this does not prove

- Production readiness, meaning liquidity above the $50K floor, a liquidation test, or a bot uptime
  SLA. The bot going down makes the LP price stale after 15 minutes, which blocks accounts holding LP
  collateral. Mitigation for the test: monitor the bot and use the oracle circuit breaker.
- Liquidator exit for wrapped LP tokens, which depends on outside liquidity.
