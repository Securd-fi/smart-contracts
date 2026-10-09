# STST Add-Gas Flow: Testnet Transactions

Confirms the two-transaction "Add Gas" gas-payment pattern for STST, an IOU with no
in-kind Axelar gas price configured. Requested by an Axelar contact: SUPPLY/REPAY must
set `gas_fee_amount = "0"` on the `interchain_transfer` Payment (so the full token amount
is delivered, none skimmed for gas) and pay relay gas separately, in native XRP, via a
second "Add Gas" Payment to the Axelar gateway referencing the transfer's tx hash as
`msg_id`.

New scripts used (existing in-kind-gas scripts were left untouched):
- [scripts/submitXrplStsTSupplyAddGas.ts](../scripts/submitXrplStsTSupplyAddGas.ts)
- [scripts/submitXrplStsTRepayAddGas.ts](../scripts/submitXrplStsTRepayAddGas.ts)

ENTER_MARKET and BORROW used existing unmodified scripts (`submitXrplEnterMarket.ts`,
`submitXrplBorrow.ts`) — included here only as supporting steps needed to have an
outstanding borrow to repay.

---

## Accounts

| | Address |
|-|---------|
| **XRPL Ledger wallet** | `r4obbPExFxVcmqUBr5jepsdtDLX3htdq48` |
| **XRPL EVM user proxy** | `0x4409B6F95DbE77398cE9D4B7FA1E146bfE5B5e86` |
| **Bridge adapter** | `0x7AC8Df85448037c6fE1eD5732c6ca71060069237` |
| **sSTST cToken market** | `0x2F874D87E685EC28be749B781dc99119F27CF0be` |
| **STST underlying (XRPL EVM ERC20)** | `0x075cEB633c10B74Ed678D1623746bddff6b98517` |
| **Comptroller (Unitroller proxy)** | `0x46d364257112230022E72b086Df85a6b0f8D3F86` |
| **Axelar XRPL testnet gateway / STST issuer** | `rNrjh1KGZk2jBR3wPfAQnoidtFFYQKbQn2` |

---

## Transaction 1 — SUPPLY, leg 1: interchain_transfer (`gas_fee_amount = "0"`)

**Flow**: XRPL Ledger → XRPL EVM via Axelar ITS (`interchain_transfer`)
**Action**: User sends 5 STST with `gas_fee_amount` memo set to `"0"` — no gas skimmed
from the transfer. Gas is paid separately in Transaction 2.

### Explorer Links

| | Link |
|-|------|
| **XRPL Ledger tx** | https://testnet.xrpl.org/transactions/BE5588CD8E1C946C6D793AB17CDADCD6A417421B5331649BCC43E2A931E5F8E2 |
| **Axelarscan GMP** | https://testnet.axelarscan.io/gmp/be5588cd8e1c946c6d793ab17cdadcd6a417421b5331649bcc43e2a931e5f8e2 |

### Key Parameters

```
actionType:    SUPPLY (0)
amount:        5,000,000,000,000,000,000 wei  (5 STST, 18-decimal)
iouValue:      "5"  (no gas added on top)
gas_fee_amount memo: "0"
Axelar memo:   type = interchain_transfer
intentId:      0xb63e0ef191465abf4bcf2c464106b83ac7b4a4ab385983ccfe40f86dde72657b
nonce:         18
```

---

## Transaction 2 — SUPPLY, leg 2: Add Gas (native XRP)

**Flow**: XRPL Ledger → Axelar gateway (direct Payment, no GMP/ITS memo type)
**Action**: Separate native-XRP Payment topping up relay gas for Transaction 1,
referencing its hash as `msg_id`.

### Explorer Links

| | Link |
|-|------|
| **XRPL Ledger tx** | https://testnet.xrpl.org/transactions/CE5FFBFE9A51BE365B75A6AAB515AE2114DE74466740A28E6093C6282C37B217 |

### Key Parameters

```
Amount:        2,000,000 drops (2 XRP)
Destination:   rNrjh1KGZk2jBR3wPfAQnoidtFFYQKbQn2  (Axelar gateway)
Axelar memo:   type = add_gas
               msg_id = be5588cd8e1c946c6d793ab17cdadcd6a417421b5331649bcc43e2a931e5f8e2
```

Axelarscan's `gas_paid` record for the SUPPLY message confirmed pairing:
`gasFeeAmount: "2000000"`, `messageId` matching Transaction 1's hash exactly,
`is_insufficient_fee: false`.

### XRPL EVM execution

| | |
|-|-|
| **Adapter tx** | `0x806baedb17c3bbed7657da8a0eb8638fce2e1f351bc98338dbe2f1278d741f7a` |

### Before / After

| Metric | Before | After |
|--------|--------|-------|
| Nonce | 18 | **19** |
| Proxy sSTST balance | 5.000000000000000000 | **9.997617927541186684** |
| Borrow balance | 0 | 0 |

`IntentExecuted`: `amount = 5,000,000,000,000,000,000` (full 5 STST — nothing lost to gas).
`Mint`: proxy received `4,997,617,927,541,186,684` sSTST.

---

## Transaction 3 — ENTER_MARKET (unmodified existing script)

**Flow**: XRPL Ledger → XRPL EVM via Axelar GMP (`call_contract`)
**Action**: Enables the sSTST balance as collateral. Required before borrowing, since
SUPPLY no longer auto-enters the market (cToken design). Pays gas directly in XRP
as part of the single `call_contract` Payment — the Add-Gas pattern does not apply here
because there is no token amount to skim gas from in the first place.

### Explorer Links

| | Link |
|-|------|
| **XRPL Ledger tx** | https://testnet.xrpl.org/transactions/92FE5E0B10E8B4CA468DC016428CA3A114AB9731986E058746128DDC786DB34A |
| **Axelarscan GMP** | https://testnet.axelarscan.io/gmp/92fe5e0b10e8b4ca468dc016428ca3a114ab9731986e058746128ddc786db34a |

### Before / After

| Metric | Before | After |
|--------|--------|-------|
| Nonce | 19 | **20** |
| Market membership | OUT | **IN** |
| Account liquidity | 0 | **7.000639000265412004** (STST-equivalent) |

### Key Parameters

```
actionType: ENTER_MARKET (4)
amount:     0  (no tokens)
gasDrops:   3,000,000
```

---

## Transaction 4 — BORROW 0.5 STST (unmodified existing script)

**Flow**: XRPL Ledger → XRPL EVM via Axelar GMP (`call_contract`) → ITS egress to XRPL Ledger
**Action**: Borrowed against the sSTST collateral, purely to create an outstanding debt
to repay in Transaction 5/6. Pays gas directly in XRP — Add-Gas pattern not applicable
(no inbound token).

### Explorer Links

| | Link |
|-|------|
| **XRPL Ledger tx** | https://testnet.xrpl.org/transactions/F11AFE6C0FD2A8C41CBCE036DB63B71F7C32142CBEA700A3007DCB4EB4D8B831 |
| **Axelarscan GMP** | https://testnet.axelarscan.io/gmp/f11afe6c0fd2a8c41cbce036db63b71f7c32142cbea700a3007dcb4eb4d8b831 |

### Before / After

| Metric | Before | After |
|--------|--------|-------|
| Nonce | 20 | **21** |
| Borrow balance | 0 | **0.5 STST** (500,000,000,000,000,000) |

### Key Parameters

```
actionType: BORROW (1)
amount:     500,000,000,000,000,000 wei  (0.5 STST)
gasDrops:   3,000,000  (gas only — no token transfer inbound)
```

---

## Transaction 5 — REPAY, leg 1: interchain_transfer (`gas_fee_amount = "0"`)

**Flow**: XRPL Ledger → XRPL EVM via Axelar ITS (`interchain_transfer`)
**Action**: User sends 0.5 STST with `gas_fee_amount` memo set to `"0"` to repay the
borrow created in Transaction 4. Gas is paid separately in Transaction 6.

### Explorer Links

| | Link |
|-|------|
| **XRPL Ledger tx** | https://testnet.xrpl.org/transactions/4E7E0BEF100A107EA16BBEE2173196E1DB82854810445DF7C1B3EA7FC1D2E785 |
| **Axelarscan GMP** | https://testnet.axelarscan.io/gmp/4e7e0bef100a107ea16bbee2173196e1db82854810445df7c1b3ea7fc1d2e785 |

### Key Parameters

```
actionType:    REPAY (2)
amount:        500,000,000,000,000,000 wei  (0.5 STST, 18-decimal)
iouValue:      "0.5"  (no gas added on top)
gas_fee_amount memo: "0"
Axelar memo:   type = interchain_transfer
intentId:      0xea090619ca46bcdcc516b5201ef1788de7722d8caf21b0a91bc5181f71e394a6
nonce:         21
```

---

## Transaction 6 — REPAY, leg 2: Add Gas (native XRP)

**Flow**: XRPL Ledger → Axelar gateway (direct Payment, no GMP/ITS memo type)
**Action**: Separate native-XRP Payment topping up relay gas for Transaction 5,
referencing its hash as `msg_id`.

### Explorer Links

| | Link |
|-|------|
| **XRPL Ledger tx** | https://testnet.xrpl.org/transactions/1B0C01423AA1C7A0FF2D4B179FD2B4CDAF22F4D6838EF18060C846A460624603 |

### Key Parameters

```
Amount:        2,000,000 drops (2 XRP)
Destination:   rNrjh1KGZk2jBR3wPfAQnoidtFFYQKbQn2  (Axelar gateway)
Axelar memo:   type = add_gas
               msg_id = 4e7e0bef100a107ea16bbee2173196e1db82854810445df7c1b3ea7fc1d2e785
```

### XRPL EVM execution

| | |
|-|-|
| **Adapter tx** | `0x1a5f266b64c2a9e474ab594840c483ad38209287805b492c961209d06409e816` |

### Before / After

| Metric | Before | After |
|--------|--------|-------|
| Nonce | 21 | **22** |
| Borrow balance | 0.5 STST | **0.000000028614717875** (fully repaid, dust = accrued interest) |
| Proxy sSTST balance | 9.997617927541186684 | 9.997617927541186684 (unchanged — repay clears debt, not collateral) |

`IntentExecuted`: `actionType = 2` (REPAY), `amount = 500,000,000,000,000,000` (full 0.5
STST — nothing lost to gas).

---

## Final State (All Operations Confirmed)

| Metric | Value |
|--------|-------|
| Nonce | **22** |
| Proxy sSTST balance | **9.997617927541186684** |
| Proxy borrow balance | **~0** (0.000000028614717875 dust interest) |
| Market membership | **IN** |

---

## Flow Summary

```
SUPPLY (leg 1) → ITS interchain_transfer, gas_fee_amount=0 → STST inbound, no gas skimmed
SUPPLY (leg 2) → Add Gas Payment (native XRP)              → tops up relay gas via msg_id
ENTER_MARKET   → GMP call_contract                          → comptroller.enterMarkets()
BORROW         → GMP call_contract                          → cToken.borrow() + ITS egress
REPAY (leg 1)  → ITS interchain_transfer, gas_fee_amount=0  → STST inbound, no gas skimmed
REPAY (leg 2)  → Add Gas Payment (native XRP)               → tops up relay gas via msg_id
```

| Action | Mechanism | Add-Gas pattern needed? | Why |
|--------|-----------|--------------------------|-----|
| SUPPLY | ITS `interchain_transfer` | **Yes** | Token-bearing; STST has no in-kind gas price |
| REPAY | ITS `interchain_transfer` | **Yes** | Token-bearing; STST has no in-kind gas price |
| BORROW | GMP `call_contract` | No | No inbound token — gas already paid directly in XRP |
| WITHDRAW | GMP `call_contract` | No | No inbound token — gas already paid directly in XRP |
| ENTER_MARKET | GMP `call_contract` | No | No inbound token — gas already paid directly in XRP |
| EXIT_MARKET | GMP `call_contract` | No | No inbound token — gas already paid directly in XRP |

## Operational Note

Both Add-Gas legs were accepted and correctly paired by Axelar's relayer (no
`is_insufficient_fee`, no reverts), but end-to-end relay time through the
approve → execute hop on XRPL EVM ran longer than the usual ~30-60s window for the
single-transaction in-kind-gas flow — budget a few minutes when building UI/UX around
this pattern.
