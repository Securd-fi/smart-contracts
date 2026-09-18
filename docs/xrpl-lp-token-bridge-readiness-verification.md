# XRP/USDC LP and XRP/ARMY LP — Mainnet Bridge Readiness Verification

**Date:** 2026-06-20
**Scope:** Axelar bridge readiness for the XRP/USDC and XRP/ARMY native XRPL AMM LP
tokens, ahead of Securd's mainnet launch.
**Status:** Securd's own lending protocol (`Unitroller`/`Comptroller`/
`XRPLSecurdBridgeAdapter`/cTokens/oracle) is **not yet deployed on XRPL EVM mainnet**.
This document only verifies the Axelar bridge plumbing for these two LP tokens — it
does not mean they are listed or usable on Securd yet, since Securd mainnet doesn't
exist yet to list them on.

XRP/RLUSD LP is excluded from this verification — see
[xrpl-amm-collateral-analysis.md](xrpl-amm-collateral-analysis.md) and
[securd-asset-listing-risk-parameters.md](securd-asset-listing-risk-parameters.md) for
the `AMMClawback`/freeze risk findings that put it on hold.

Every finding below was checked directly against live XRPL mainnet and XRPL EVM
mainnet state — not taken from a report — using `xrplcluster.com` (XRPL JSON-RPC) and
`rpc.xrplevm.org` (XRPL EVM JSON-RPC).

---

## 1. XRPL Ledger — AMM pool health

| | XRP/USDC | XRP/ARMY |
|---|---|---|
| Pool (pseudo-)account | `rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE` | `rnsRq5ahgbFeRiAgBVvFTafyAgiS9x9Ztn` |
| XRP reserve | 246,178.249294 XRP | 239,366.023938 XRP |
| Other asset reserve | 281,953.55 USDC | 42,339,147.88 ARMY |
| `asset2_frozen` (live `amm_info`) | `false` | `false` |
| Pool account `Flags` | `0x01900000` = `lsfDepositAuth` + `lsfDefaultRipple` + `lsfDisableMaster` | same |
| LP token currency | `03B20F3A7D26D33C6DA3503E5CCE3E67B102D4D2` | `037C2A57B0011520DE389E332043EC0FAF858ACE` |
| LP token issuer | the pool account itself | the pool account itself |

The pool flags are the expected, correct set for a genuine AMM pseudo-account (master
key disabled, deposit auth required so only AMM transactions can move funds) — no
anomalies. Neither pool is currently frozen.

## 2. XRPL Ledger — Axelar custody trustline (lock side)

The Axelar mainnet XRPL gateway account is `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`
(confirmed against the same address already used for USDC/USDT/WETH/WBTC in
[securd-asset-listing-risk-parameters.md](securd-asset-listing-risk-parameters.md)).

Paginated through all 4,269 trustlines on this account (`account_lines`, full scan, not
just a peer-filtered query) and confirmed both LP token trustlines exist:

```
XRP/USDC LP -> { account: rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE,
                 currency: 03B20F3A7D26D33C6DA3503E5CCE3E67B102D4D2,
                 limit: 9999999999999999e80, balance: 0 }

XRP/ARMY LP -> { account: rnsRq5ahgbFeRiAgBVvFTafyAgiS9x9Ztn,
                 currency: 037C2A57B0011520DE389E332043EC0FAF858ACE,
                 limit: 9999999999999999e80, balance: 0 }
```

Both trustlines are open with an effectively unlimited limit. Balance is `0` because
nothing has been bridged yet — this is expected, not a problem.

## 3. XRPL EVM mainnet — wrapped token (mint/burn side)

Decoded the actual `InterchainTokenDeployed` / `TokenManagerDeployed` events from the
deployment transactions (not inferred from raw logs):

| | XRP/USDC LP | XRP/ARMY LP |
|---|---|---|
| Deployment tx | [`0x07d6bb6b...a35e7c`](https://explorer.xrplevm.org/tx/0x07d6bb6b2bdf124027822f59b8623893110505efe63ed6d34401b36735a35e7c) | [`0x4c5907be...e0b31e532`](https://explorer.xrplevm.org/tx/0x4c5907beadbdf234b9667a149d30b8358daea98f4d4ab159b2fc500e0b31e532) |
| Token address | `0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53` | `0xD66b43e8a145e3b9e2d7e0F12f28255CB647Db7e` |
| ITS `tokenId` | `0xe2f2d147cc5da2f15c947b85d9a0bd88dc7e64bf864725a76b064002a06e291b` | `0x1531fd6c4c214c74ed2c93c7692c39e109eaf0e6057d26c19b2f24e542294a23` |
| `tokenManagerType` | `0` = `NATIVE_INTERCHAIN_TOKEN` | `0` = `NATIVE_INTERCHAIN_TOKEN` |
| Token manager address | `0x608Db4fc44167E8EaC7402994762d9284E1d3809` | `0x84fad8dE57d0727034328fF858C7f06f4d2A45DC` |
| name / symbol / decimals | XRP-USDC AMM LP / XRPUSDC-LP / 15 | XRP-ARMY AMM LP / XRPARMY-LP / 15 |
| Current `totalSupply` | 0 | 0 |
| Receipt status | success (`status: 1`) | success (`status: 1`) |

`tokenManagerType = 0` (`NATIVE_INTERCHAIN_TOKEN`) is the correct type for the
destination side of a lock-unlock (XRPL) ↔ mint-burn (XRPL EVM) bridge — ITS itself
controls minting and burning of these tokens, matching the architecture confirmed
earlier in this conversation. 15 decimals matches XRPL's native LP-token precision
(no precision loss when bridging). `totalSupply = 0` on both is expected since nothing
has been bridged yet.

## 4. ARMY external price-feed precondition

`securd-asset-listing-risk-parameters.md` gates the XRP/ARMY LP market on ARMY having
"an external price feed independent of this pool" before activation. Confirmed: ARMY
(XRPL, traded on First Ledger) has an independent listing on
[CoinGecko](https://www.coingecko.com/en/coins/army-3) (~$5M market cap) and
CoinMarketCap. Precondition satisfied.

Note: the documented LP oracle formula for this pool already prices the LP token using
only the XRP-side reserve (ARMY itself valued at $0, deliberately conservative), so this
external feed isn't actually consumed by the oracle math as currently designed — it's
useful as a sanity/liveness check, not a hard pricing dependency. Worth deciding whether
to keep it as a formal go/no-go gate or downgrade it to informational.

## 5. What's confirmed vs. what's still outstanding

**Confirmed ready (Axelar bridge layer):**
- Both AMM pools are healthy, not frozen, structurally normal.
- Both LP tokens have no clawback risk (`lsfAllowTrustLineClawback = FALSE` on both
  underlying-asset issuers, verified in the prior risk-flag audit).
- Axelar's mainnet XRPL gateway already holds open trustlines for both LP currencies.
- Both wrapped ERC-20 representations are deployed on XRPL EVM mainnet with the correct
  `NATIVE_INTERCHAIN_TOKEN` manager type and a registered `tokenId` linking them back to
  the XRPL-side LP currency/issuer.
- ARMY's external price-feed precondition is satisfied.

**Not yet done (Securd protocol layer — out of scope for the bridge, but required
before these tokens are actually usable on Securd):**
- No `Unitroller`/`Comptroller` deployed on XRPL EVM mainnet.
- No `XRPLSecurdBridgeAdapter` deployed/configured on mainnet.
- No cToken markets exist yet for either wrapped LP token.
- No oracle (`FALLBACK` mode, per architecture) configured for either LP token's price.
- Once Securd's mainnet stack exists, each LP market still needs: `_supportMarket` on
  the Comptroller, `setMarket(...)` on the bridge adapter (market, underlying, `tokenId`
  from the table above, `listed = true`), and oracle fallback-mode registration with an
  authorized price-posting bot — per the parameters already defined in
  [securd-asset-listing-risk-parameters.md](securd-asset-listing-risk-parameters.md).

**Bottom line:** the Axelar-side bridge for XRP/USDC LP and XRP/ARMY LP is fully ready
and verified on mainnet today. There is nothing blocking these two tokens from being
bridged. The remaining work before they're usable on Securd is entirely on Securd's own
mainnet deployment, which has not started yet.
