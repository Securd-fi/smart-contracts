# SecurdCollateralFactorTimelockV2 — Audit Report (not deployed)

Scope: `contracts/core/SecurdCollateralFactorTimelockV2.sol`, its mock, and
`test/unit/collateralFactorTimelockV2.spec.ts`. Compared line by line against the deployed
`SecurdCollateralFactorTimelock` (`0xEB27E14a7E7Dd1652FBC6220df56F28a6b1047Fb`).

Status: **not deployed, no admin migration performed.** Deploying V2 and moving the Comptroller admin to
it is a separate governance decision (see "Migration" below).

## What changed, and why

The deployed timelock's `execute` treats any 32-byte return value as a Compound error code and reverts
on non-zero. Comptroller pause functions (`_setMintPaused`, `_setBorrowPaused`, `_setTransferPaused`,
`_setSeizePaused`) return `bool`, the new state. A successful pause returns `true` (1), so the deployed
timelock reverts it. An unpause returns `false` (0), which the deployed timelock accepts. The ARMY pause
attempt on 2026-10-05 failed for this reason and was cancelled. Nothing changed on-chain.

V2 changes only the return-value interpretation:
- Four known bool selectors (`_setMintPaused(address,bool)`, `_setBorrowPaused(address,bool)`,
  `_setTransferPaused(bool)`, `_setSeizePaused(bool)`): success means the call didn't revert and returned
  a canonical bool (0 or 1). `false` is a valid success (unpause). Any other value reverts with
  `InvalidBoolReturn`.
- All other calls: unchanged. A 32-byte return is a uint error code, and non-zero reverts.

Everything else is identical: owner-only queue/execute/cancel, the 48-hour minimum for
`_setCollateralFactor`, the 30-day maximum delay, the 7-day grace period, and `acceptUnitrollerAdmin`.
The 48-hour minimum is a constant, not a setting.

## Review pass 1 — line-by-line diff against the deployed contract

- Selectors: the four bool selectors were checked against the signatures in `Comptroller.sol` lines
  1058–1087. Each takes `(CToken,bool)` or `(bool)`, and the ABI type of `CToken` is `address`, so the
  selectors are correct.
- The CEI order is kept: the action is deleted before the external call, so a reentrant call finds no action.
- The `value` forwarding is unchanged. The owner controls it through `queue`, as before.
- Delay checks run on the calldata selector, so a collateral-factor change cannot dodge the 48-hour rule by
  changing the target. The rule is keyed on the call, not the contract.
- Result: no unintended changes outside the return-value handling.

## Review pass 2 — behavioural tests

15 passing tests (`npx hardhat test test/unit/collateralFactorTimelockV2.spec.ts`), covering:
- bool success (`true`), bool unpause (`false` accepted), and the non-canonical bool `2` rejected;
- uint error codes: non-zero reverts, zero executes;
- the 48-hour minimum (rejects 1 second less, accepts exactly 48 hours), execution before eta, and
  execution after the 7-day grace period;
- the 30-day maximum delay;
- owner-only access, cancel, zero-target rejection, and distinct ids for the same action queued later.

Two test-side assumptions were corrected during the run: OpenZeppelin 4.9.6 uses string reverts for
`onlyOwner`, and the same action queued in a later block gets a different eta, so a different id.

## Review pass 3 — adversarial review

| # | Attack or failure mode | Result |
|---|---|---|
| A1 | Owner queues a bool pause with an arbitrary return, hoping it is accepted | Only the four selectors take the bool path. Any other return is treated as before. A bool selector returning 2 reverts. |
| A2 | A collateral-factor change queued with delay 0 | Rejected at `queue` (`DelayTooShort`). The check is on calldata, so it can't be bypassed by changing the target. |
| A3 | Execute a queued action late | After eta + 7 days it reverts `ActionExpired`. The owner must re-queue. |
| A4 | Reentry through the target | Action deleted first. Reentry finds nothing. |
| A5 | A bool selector that reverts | The whole call reverts (`ExecutionFailed`). Nothing changes. |
| A6 | Unpause treated as failure | Fixed: `false` is accepted as success. |
| A7 | Non-bool functions returning arrays (for example `enterMarkets`) | Not checked, same as before. Not a regression. Admin calls of that shape should not be queued. |
| A8 | Owner key compromise | **Not fixed by V2.** A single EOA owner can queue any action with 0 delay except collateral-factor changes. A multisig owner is required before production (see below). |
| A9 | Pause guardian acting without the timelock | By design. Pause guardian can pause instantly; that is the emergency lever. Unpause requires the admin. |

## Findings

1. **Fixed:** bool-returning pause actions could never execute through the timelock. Verified by tests.
2. **Open, production-blocking:** the owner is a single EOA, `0x57eb9411CA49752994b81cd1B60c3917Cb99247C` (`DEPLOY_OWNER` in `docs/xrpl-evm-mainnet-deployment.md`). Move the owner to a multisig before any
   production use, and before the Comptroller admin is handed to any timelock.
3. **Open, minor:** non-bool and non-uint return shapes are not checked. Document which admin calls may be queued.
4. **Open, process:** the migration (step 1 below) is the governance change, and it is not covered by this audit.

## Migration (not performed)

Any move of the Comptroller admin to V2 is a governance change. It requires:
1. The current timelock to queue `_setPendingAdmin(V2)` on the Unitroller proxy
   (`contracts/core/Unitroller.sol:89`), with no delay (it is not a collateral-factor change). This changes
   who controls the Comptroller only. Each market's cToken admin is a separate setting (set to the owner at
   deploy time), so it is not moved by this step and must be checked separately.
2. V2 to call `acceptUnitrollerAdmin` (it calls `_acceptAdmin` on the Unitroller).
3. A written decision by the owner, a second reviewer of the calls, and a rollback plan (the same two steps in
   reverse, through the current timelock).

This audit recommends against migrating for the 7 October test. The existing timelock already executes the
collateral-factor change on 2026-10-07 11:34 UTC. V2 is needed for future bool pause actions through the
timelock, and it should be deployed with a multisig owner.

## Conclusion

V2 fixes the bool-return bug without weakening governance: the 48-hour minimum, the grace period, and owner-only
access are all unchanged. It is ready for an independent audit. It is not ready to govern live markets until the
owner is a multisig and that audit is done.
