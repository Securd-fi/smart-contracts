# Securd × Squid — Cross-Chain EVM Liquidity Bridge Integration Specification

**Goal:** let a user holding assets on any other EVM chain (Ethereum, Arbitrum, Base,
etc.) bridge liquidity into Securd on XRPL EVM mainnet in one source-chain signature,
using Squid (Axelar's swap/bridge aggregator) — without touching XRPL Ledger, the
signed-intent system, or `XRPLSecurdBridgeAdapter` at all.

**Status:** Design specification. No Securd contract changes are required for the
baseline flow (§4–§5) — it composes entirely from Squid's existing hook mechanism and
Securd's existing, unmodified `CErc20`/`Comptroller`. Securd's own mainnet deployment
does not exist yet (per [xrpl-lp-token-bridge-readiness-verification.md](xrpl-lp-token-bridge-readiness-verification.md));
addresses below are marked TBD until it does.

---

## 1. Why this path is architecturally simpler than the XRPL Ledger flow

Everything in [securd-lp-leverage-delta-neutral-strategy-spec.md](securd-lp-leverage-delta-neutral-strategy-spec.md)
exists because XRPL Ledger users have no EVM wallet at all — Securd had to build a
signed-intent system, deterministic per-user proxies, and a dedicated bridge adapter
just to let an XRPL account safely instruct an EVM contract.

**None of that applies here.** A user bridging from Ethereum/Arbitrum/etc. already has
a normal EVM wallet address. XRPL EVM is just another EVM chain to that wallet — once
funds land there, the user can call Securd's standard `CErc20`/`Comptroller` functions
directly, the same way they'd interact with any cToken-style market on any other
EVM chain. The only cross-chain problem to solve is getting the asset from chain A to
XRPL EVM. That is exactly what Squid does, and nothing about it needs to route through
`XRPLSecurdBridgeAdapter`, `XRPLUserProxyFactory`, or the `intentSignerOfXrplAccount`
mechanism — those exist solely for the XRPL-Ledger-origin path and are untouched by
this integration.

---

## 2. Verified facts about Squid/Axelar for this integration

Checked directly against Squid's current documentation rather than assumed:

- **XRPL EVM is a first-class, standard EVM destination in Squid's chain list**:
  `networkIdentifier: "xrpl-evm"`, `chainId: 1440000`, `type: "evm"`. This is distinct
  from `xrpl-mainnet` (native XRPL Ledger), which Squid handles through a completely
  different, non-EVM `DEPOSIT_ADDRESS_CALLDATA` flow described in its XRPL integration
  guide. **This spec only uses the standard EVM route-building path** — the XRPL-Ledger-specific
  flow is irrelevant here.
- **Squid supports destination-chain "postHooks"**: arbitrary contract calls executed
  automatically after a bridge/swap completes, chainable (an arbitrary number of calls
  per hook), with Squid's own documented example being *"deposit USDC into [a] lending
  pool"* after bridging — i.e., this exact use case is a first-party supported pattern,
  not a stretch.
- **Where bridged tokens land before the hook runs**: Squid's own Multicall contract on
  the destination chain, *not the user's wallet*. The postHook calls execute with the
  Multicall contract as `msg.sender`. This is the detail that drives §4.
- **`callType: 1` (`FULL_TOKEN_BALANCE`)** lets a postHook call inject "whatever amount
  actually arrived" into a specific calldata position at execution time, since bridge
  output amounts aren't known precisely in advance (fees, slippage). This is the
  mechanism that makes §4's fix possible without any new contract.
- Squid also runs a newer intent-based settlement layer ("Squid Intents," introduced
  March 2026, sub-5-second settlement for swaps under $20K via its CORAL RFQ system).
  Confirm at implementation time whether Securd's destination-chain calls (the postHook
  chain in §4) are supported under Intents-routed swaps the same way as under classic
  routed swaps — this wasn't confirmed in available documentation and should be
  verified directly with Squid before relying on it for larger transfers.

---

## 3. The catch: `mint()` credits `msg.sender`, not the user

Verified directly against the deployed contract code, not assumed:

```solidity
// contracts/core/CToken.sol
function mintInternal(uint mintAmount) internal nonReentrant {
    accrueInterest();
    mintFresh(msg.sender, mintAmount);   // <- msg.sender, no recipient parameter
}
```

There is no `mintFor(recipient, amount)` variant — this is standard, unmodified
standard cToken behavior. If a postHook calls `CErc20(cToken).mint(amount)` directly, the
**Squid Multicall contract** becomes `msg.sender`, and the freshly minted cTokens are
credited to *Squid's* contract address, not the user's wallet. Unlike Aave/Radiant-style
protocols (which expose an explicit `onBehalfOf` parameter, the pattern Squid's own
example relies on), Securd's `CErc20` has no such parameter — this is a genuine gap
specific to cToken-shaped markets, not something Squid's documented example
directly covers.

## 4. The fix — a 3-call postHook chain, zero contract changes

Since `CToken` is itself a standard transferable ERC20-like token, the fix is to chain
one more call that moves the freshly minted cTokens from the Multicall contract to the
user, using the same `FULL_TOKEN_BALANCE` mechanism Squid already uses for the
approve→mint amount:

| Step | Call | `callType` | Effect |
|---|---|---|---|
| 1 | `IERC20(underlying).approve(cToken, <bridged amount>)` | `1` (`FULL_TOKEN_BALANCE`, `payload.tokenAddress = underlying`) | Approves the cToken market to pull the exact amount that actually arrived |
| 2 | `CErc20(cToken).mint(<bridged amount>)` | `1`, same `payload.tokenAddress = underlying` | Mints cTokens — credited to the Multicall contract (§3) |
| 3 | `CToken(cToken).transfer(<user address>, <minted cToken amount>)` | `1`, `payload.tokenAddress = cToken` | Moves the cTokens just minted in step 2 from the Multicall contract to the user's own wallet |

Step 3 is the fix: it doesn't need to know the exact cToken amount minted in step 2 in
advance (which depends on the live exchange rate at execution time) — `FULL_TOKEN_BALANCE`
against the cToken address handles that automatically, exactly the same trick already
used between steps 1 and 2.

**Verified this doesn't hit any unexpected guard:** `Comptroller.transferAllowed` is
gated only by a global `transferGuardianPaused` switch (admin pause) plus the sender's
own liquidity/membership state — and the Multicall contract has no debt and isn't a
market participant, so the standard liquidity check passes trivially. The only failure
mode to design around is the global pause switch, which is a known, already-monitored
protocol state (see [securd-lp-leverage-delta-neutral-strategy-spec.md §8](securd-lp-leverage-delta-neutral-strategy-spec.md)).

After step 3, the user holds the cTokens directly in their own wallet — economically
identical to having called `mint()` themselves, achieved without any change to
`CErc20`/`Comptroller`.

**Open verification item — this is the load-bearing assumption of the whole fix.**
Squid's own documented example uses `FULL_TOKEN_BALANCE` twice against the *same* token
(the bridged asset, for both the approve and the deposit calls). Step 3 above relies on
`FULL_TOKEN_BALANCE` working against the **cToken** — a token that didn't exist on the
Multicall contract's balance sheet until step 2 executed *within the same postHook
sequence*. This is a reasonable extrapolation (it's just a live balance query against an
address, mid-execution, same transaction) but it is not what Squid's documentation
explicitly shows, and it should be confirmed directly with Squid (or tested on a
testnet route) before relying on it for real funds. **Fallback if it doesn't work as
assumed:** deploy one small, non-upstream helper contract —
`SquidDepositHelper.mintFor(address cToken, uint256 amount, address recipient)` — that
pulls `amount` from `msg.sender` (the Multicall contract), calls `mint()` itself
(becoming the minter), and forwards the resulting cTokens to `recipient` in the same
call. This requires no changes to `CErc20`/`Comptroller` either — it's one new,
isolated contract, and the postHook chain collapses from 3 calls to a `approve` +
single `mintFor` call against the helper.

## 5. `ENTER_MARKET` is a required, separate follow-up — by design, not an oversight

Per this repo's own history (`refactor: remove auto-enterMarkets from SUPPLY to match
cToken design`), Securd deliberately does **not** auto-enroll fresh cTokens as
collateral on mint — `enterMarkets([cToken])` is a separate call the account itself
must make. This is structurally incompatible with putting it inside the postHook chain
in §4: `enterMarkets` operates on `msg.sender`, and by the time the postHook finishes,
the cTokens already belong to the user's address, not the Multicall contract — so this
call has to be a normal transaction the user signs from their own wallet after landing
on Securd's dApp, exactly the same UX Securd already has for any other SUPPLY action.
The dApp should prompt this automatically ("funds bridged and supplied — enable as
collateral?") as the natural last step of the flow, not as a separate, easy-to-miss
manual action.

---

## 6. Asset mapping

This flow works cleanly when the bridged asset *is* one of Securd's accepted
underlyings on XRPL EVM (USDC, USDT, WETH, WBTC) — Squid's bridge leg alone delivers the
exact token Securd expects, and the postHook chain in §4 applies directly.

**When the user wants to end up in XRP** (Securd's primary market) starting from an
asset that isn't XRP on the source chain, an additional destination-chain *swap* leg is
needed before the mint: bridge asset A → wrapped representation on XRPL EVM → swap to
XRP via XRPL EVM DEX liquidity → mint into `cXRP`. This is a longer, more failure-prone
route (more legs = more slippage exposure and more places for the route to fail) and
should be treated as a distinct, more advanced flow, not folded into the default V1
integration. Start with direct asset-to-asset routes (§ launch plan, §9) where the
bridged token already matches a Securd market 1:1.

---

## 7. dApp integration architecture

- **SDK, not just the embeddable widget**: the widget covers the bridge leg well but
  for a fully-composed bridge+supply experience, build the route directly via the Squid
  SDK so the postHook chain from §4 can be attached, then track status with Squid's
  route-status API.
- **Route construction**: `fromChain` = whichever source chain/token the user holds,
  `toChain = "xrpl-evm"` (chainId `1440000`), `toToken` = the Securd-accepted underlying
  matching the target market, `postHook.calls` = the 3-call chain in §4 targeting the
  real `cToken`/underlying addresses for that market (TBD until Securd's mainnet
  markets exist — see status note at top).
- **Status tracking**: Squid's route-status API should be polled the same way this
  project already polls Axelar's `searchGMP` API for the XRPL Ledger flow (see
  [xrpl-stst-add-gas-flow-testnet-transactions.md](xrpl-stst-add-gas-flow-testnet-transactions.md))
  — don't assume "submitted on the source chain" means "supplied on Securd"; track
  through to destination-chain execution explicitly.
- **Pre-flight checks before building the route**: market not paused
  (`mintGuardianPaused`/`transferGuardianPaused`) — verified directly against
  `Comptroller.mintAllowed`, the *only* on-chain gates on minting are the guardian pause
  and `markets[cToken].isListed`. **There is no on-chain supply cap enforcement at
  all** — `ComptrollerStorage` only defines a `borrowCapGuardian`/borrow caps, nothing
  equivalent for supply. The "Supply Cap" figures in
  [securd-asset-listing-risk-parameters.md](securd-asset-listing-risk-parameters.md)
  are an **operational/off-chain guideline** the team would need to enforce by manually
  pausing `mintGuardianPaused` if a cap is approached — a postHook mint will not
  self-block on hitting that number, it'll simply succeed past it. Oracle freshness for
  the target asset is also not a mint-time on-chain gate (minting doesn't consult the
  oracle at all in this Comptroller) — it matters for the user's *displayed* position
  value and for whether they can subsequently borrow against it, not for whether the
  mint itself succeeds.

---

## 8. Security / audit considerations

### 8.1 Multicall contract address must be verified per-chain, not assumed

Squid's Multicall contract address differs per chain and is the entity that becomes
`msg.sender` for the calls in §4. Before relying on the §4 chain, verify the canonical
Multicall address for XRPL EVM directly from Squid's chain config at integration time —
do not hardcode an address copied from another chain's deployment.

### 8.2 PostHook failure mode — funds are not lost, but need a defined recovery path

If step 2 (`mint`) reverts — verified against `Comptroller.mintAllowed`, the realistic
causes are `mintGuardianPaused[cToken]` being set or the market not being listed; supply
caps are not an on-chain revert cause at all (§7) — the bridged tokens remain on the
Multicall contract, not delivered to the user and not supplied to Securd. Step 3
(`transfer`) reverting is a much narrower case: `transferAllowed` only fails on the
global `transferGuardianPaused` switch, since `redeemAllowedInternal` bypasses its
liquidity check entirely for an account with no market membership (the Multicall
contract, confirmed in `Comptroller.sol`). Either failure needs a defined UX response:
Squid's own route-status/recovery tooling should be the first stop, and the dApp should
detect a postHook failure explicitly (not just "transaction succeeded on the source
chain") and surface a clear remediation path, mirroring the same "in-flight state must
be visible, not assumed successful" principle already established in
[securd-lp-leverage-delta-neutral-strategy-spec.md §8.2](securd-lp-leverage-delta-neutral-strategy-spec.md).

### 8.3 This path bypasses every XRPL-Ledger-specific safety mechanism — that's correct, not a gap

Nonce sequencing, intent signatures, replay protection via `payloadHashByIntent` — none
of that applies here, and that's by design: those mechanisms exist specifically to let
an XRPL Ledger account (no EVM key) safely authorize EVM actions. A user bridging from
an EVM chain already authenticates with their own EVM key the normal way (the source
chain transaction signature), so there's nothing analogous to add. Do not be tempted to
route this flow through `XRPLSecurdBridgeAdapter` "for consistency" — it would add
friction (signed intents, nonce sequencing) for a problem that doesn't exist in this
flow, and the adapter's trusted-source allowlist is configured for XRPL-side Axelar
sources specifically, not arbitrary EVM source chains.

### 8.4 XRPL EVM's Axelar connectivity uses Amplifier — confirm this doesn't affect anything here

XRPL EVM onboarded to Axelar through Amplifier (Axelar's newer verifier framework). This
spec's flow doesn't touch `IAxelarGateway`/ITS trust configuration at all (§8.3), so it
shouldn't be affected — but confirm this explicitly before launch, since Amplifier vs.
classic-gateway connectivity is exactly the kind of infrastructure detail that's easy to
assume is irrelevant and turns out not to be.

### 8.5 Destination-chain swap leg (§6) carries normal DEX slippage/MEV exposure

Any route requiring a destination-chain swap before minting (e.g., ending in XRP from a
non-XRP source asset) inherits ordinary DEX slippage and front-running exposure on that
swap leg, on top of the bridge itself. Set explicit slippage tolerances in the route
request and surface them to the user — don't default to unlimited slippage for
convenience.

---

## 9. Phased rollout recommendation

- **V1 — bridge only, manual supply**: Squid widget bridges the user's asset to their
  own XRPL EVM wallet, full stop. The user then uses Securd's normal UI to `mint()` and
  `enterMarkets()` themselves. Zero new integration risk beyond the bridge itself —
  ships fastest, validates demand.
- **V2 — composed bridge + supply**: add the §4 postHook chain so bridging and supplying
  happen in one source-chain signature, with the dApp prompting `ENTER_MARKET` (§5) as
  the guided next step.
- **V3 — swap-then-supply for non-matching assets** (§6): only after V2 is stable,
  extend to routes ending in XRP (or other Securd markets) from arbitrary source assets
  that don't already match a Securd underlying 1:1.

Do not start at V2 — validate the simpler bridge-only path and Squid's actual reliability
for XRPL EVM as a destination before composing it with a fund-moving postHook chain.

---

## 10. Audit findings — corrections made during review

This spec was re-checked against the actual deployed contract logic (not the risk-docs'
narrative) before being finalized. Two claims in the original draft were wrong and have
been corrected in place above:

1. **Supply caps are not enforced on-chain.** `Comptroller.mintAllowed` only checks
   `mintGuardianPaused[cToken]` and `markets[cToken].isListed` — confirmed by reading
   the function directly. `ComptrollerStorage` defines a `borrowCapGuardian`/borrow
   caps, but there is no equivalent for supply. The original draft of §7/§8 claimed a
   postHook mint could revert from hitting a supply cap — that's incorrect; the "Supply
   Cap" figures in `securd-asset-listing-risk-parameters.md` are purely an
   operational/off-chain guideline today, not an on-chain guard. This matters
   concretely for this integration: nothing stops a large bridged mint from pushing a
   market past its intended operational cap, so the dApp (or an off-chain monitor) has
   to enforce that limit itself if it matters, the same way the team would for any other
   SUPPLY path.
2. **The §4 fix's load-bearing assumption was stated with more confidence than it had
   evidence for.** Squid's documented `FULL_TOKEN_BALANCE` example only shows it used
   twice against the *same*, originally-bridged token. This spec's step 3 relies on the
   same mechanism working against a *different* token (the cToken) that's created mid-sequence,
   inside the same postHook chain. That's a reasonable engineering extrapolation, not a
   documented guarantee — now flagged explicitly in §4 as an open verification item,
   with a concrete fallback (a small `mintFor`-style helper contract) if it turns out
   not to be supported.

Everything else in this spec — the `mint()`/`msg.sender` gap (§3), the
`ENTER_MARKET`-must-stay-separate constraint (§5), and the `transferAllowed`/
`redeemAllowedInternal` trivial-pass-for-non-member-accounts behavior (§4, §8.2) — was
verified directly against `CToken.sol`/`Comptroller.sol` and held up under review.
