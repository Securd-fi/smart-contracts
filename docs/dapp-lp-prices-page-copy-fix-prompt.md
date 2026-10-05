# dApp Fix Prompt — LP Prices Page Copy (`/lp-prices`)

Prompt prepared for the dApp developer to hand to his own Claude Code instance. Companion to
[xrpl-evm-mainnet-dapp-integration-review.md](xrpl-evm-mainnet-dapp-integration-review.md) and
[15-xrpl-lp-oracle-bot.md](15-xrpl-lp-oracle-bot.md) (the canonical LP pricing formula this fix references).

## Context

Reviewed `https://mainnet.securd.fi/lp-prices` (2026-10). The page's explanatory copy frames "Oracle price"
and "DEX value" as if they were two independently-sourced prices that can be compared for agreement — the
way you'd check a Chainlink feed against a DEX price. That is not accurate for LP tokens: the XRPL AMM pool
(plus Band/Chainlink prices for the two underlying assets) is the *only* source of price discovery. "Oracle
price" is `DEX value × (1 − haircut)`, a pure arithmetic transform of the same number (see
`computePublishedPriceMantissa` in `scripts/runXrplLpOracleBot.ts`, and
[15-xrpl-lp-oracle-bot.md](15-xrpl-lp-oracle-bot.md) §18).

**Verified before writing this prompt, not assumed:**
- Live chain state: `fallbackPriceOf` on `SecurdPriceOracle` (`0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98`)
  returns `priceMantissa: 0, updatedAt: 0` for both `sXRPUSDCLP` (`0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53`)
  and `sXRPARMYLP` (`0xD66b43e8a145e3b9e2d7e0F12f28255CB647Db7e`) — the oracle bot has never posted.
- The page's own content confirmed accurate given that: both markets show "Oracle price not published yet" /
  "Market not open yet", not a fabricated number — this is **not** a logic bug, the initial concern that it
  might be computed client-side was raised and then retracted after seeing the actual rendered content.
- Displayed DEX values are internally consistent with displayed TVL/Supply (e.g. XRP/USDC LP: $31.03K / 11.56M
  LP ≈ $0.002684, matches the displayed value exactly).
- Static page source (`curl`-fetched raw HTML) is 100% client-rendered beyond one static help-text paragraph —
  confirmed byte-identical across two checks, no fix deployed as of this writing.

**Conclusion: copy-only fix, no code/logic change needed.** The risk is forward-looking — once the oracle bot
starts posting real prices, the page will show two numbers side by side that always differ by roughly the
haircut percentage, and the current copy doesn't explain why, inviting a misread as disagreement rather than
design.

## The prompt

---

**Tighten the LP price source copy on `/lp-prices` — clarify before the oracle bot goes live**

Current help text, confirmed live in the page source as of this writing (byte-identical, unchanged):

> "Oracle price is the price the protocol uses for LP collateral, haircut included. DEX value is the LP value computed from the XRPL AMM pool."

Current chart legend (different wording, same gap):

> "Oracle price (used by the protocol)" / "DEX value (XRPL AMM, no haircut)"

Both are technically harmless right now because "Oracle price" shows "Not published yet" / "Market not open yet" for both LP markets — confirmed accurate: I checked live chain state directly (`fallbackPriceOf` on `SecurdPriceOracle` at `0xeB8FFB77FFD6c8DccB4DEf02D670C0A1b791FF98`) and both `sXRPUSDCLP` (`0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53`) and `sXRPARMYLP` (`0xD66b43e8a145e3b9e2d7e0F12f28255CB647Db7e`) return `priceMantissa: 0, updatedAt: 0` — the oracle bot has never posted. I also sanity-checked the displayed DEX values against TVL/Supply and they're internally consistent (e.g. $31.03K / 11.56M LP ≈ $0.002684, matches exactly). So there's nothing live to misread as a discrepancy today, and no code/logic bug — this is a copy-only fix, done proactively.

The gap: neither text makes clear that for LP tokens, **the AMM pool is the only source of price discovery, full stop.** "Oracle price" is `DEX value × (1 − haircut)` — a pure arithmetic transform of the same number, not an independent feed. Once the oracle bot starts posting (the whole point of building it), this page will show two numbers side by side that will always differ by roughly the haircut percentage, and without this clarification a user could easily read that gap as the two sources disagreeing rather than the haircut working as designed. Fix the copy now, before that's live.

**Fix, both places:**

1. **Top help text** → replace with: *"LP token value has exactly one source: the XRPL AMM pool reserves, combined with the live prices of the two underlying assets — there is no independent price feed for the LP token itself. 'Oracle price' is this same value with a haircut subtracted, posted on-chain periodically by the oracle bot; expect it to differ from the live DEX value by roughly the haircut percentage, not as a discrepancy."*

2. **Chart legend** → replace with: *"Oracle price — AMM value with haircut applied, posted periodically"* / *"DEX value — live AMM value, no haircut"*. Keep both legend lines, just make the derivation relationship explicit instead of implying two separate sources.

3. **Consolidate:** having both a top help-text paragraph and a separate chart legend saying almost the same thing is redundant and risks the two drifting out of sync over time. Either cut one, or make the legend a short label that links/hovers to the fuller top explanation.

**No code or logic changes required.** The "not published yet" / "Market not open yet" states already correctly reflect live on-chain state — don't touch that logic, this is copy-only.

---

## Status

Not yet sent / not yet applied as of this writing. Re-check `https://mainnet.securd.fi/lp-prices` after the
developer applies the fix to confirm the copy changed and no regression was introduced to the "not published
yet" state logic.
