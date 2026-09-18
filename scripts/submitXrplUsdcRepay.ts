/**
 * Sends a REPAY intent for USDC.axl from XRPL Ledger mainnet to XRPL EVM mainnet sUSDC.
 * Mirrors submitXrplUsdcSupply.ts's proven IOU/interchain_transfer pattern and confirmed
 * 6-decimal scaling (actionType=2 REPAY instead of 0 SUPPLY, no egress destination needed).
 *
 * Required env vars:
 *   XRPL_SEED                  XRPL mainnet wallet seed
 *   XRPL_EVM_RPC_URL           XRPL EVM RPC endpoint
 *   INTENT_SIGNER_PRIVATE_KEY  Intent signer private key
 *   XRPL_BRIDGE_ADAPTER        XRPLSecurdBridgeAdapter address
 *   XRPL_USDC_MARKET           sUSDC cToken address
 *   XRPL_USDC_UNDERLYING       USDC ERC-20 address on XRPL EVM
 *   XRPL_USDC_REPAY_AMOUNT     Amount to repay as human-readable string (e.g. "0.01")
 *
 * Optional:
 *   XRPL_RPC_URL               default: wss://s2.ripple.com (mainnet)
 *   XRPL_AXELAR_GATEWAY        default: rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw (mainnet)
 *   XRPL_EVM_AXELAR_CHAIN      default: xrpl-evm
 *   XRPL_USDC_CURRENCY         default: 555344432E61786C000000000000000000000000 ("USDC.axl")
 *   XRPL_USDC_ISSUER           default: same as gateway
 *   XRPL_USDC_GAS_FEE          Gas fee in USDC.axl IOU units (default: "0")
 *   XRPL_CONFIRM_SEND          Set to "true" to submit
 */
import { ethers } from "ethers";
import { Client, Payment, IssuedCurrencyAmount, Wallet } from "xrpl";

const SIGNED_INTENT_TUPLE =
  "tuple(tuple(bytes32,bytes32,address,address,uint8,uint256,uint64,uint64,bytes,uint16),bytes)";

const ADAPTER_ABI = [
  "function nextNonceByXrplAccount(bytes32) view returns (uint64)",
  "function intentSignerOfXrplAccount(bytes32) view returns (address)",
  "function marketConfigOf(address) view returns (address underlying, bytes32 tokenId, bool listed)",
];

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}

function optionalEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function utf8Hex(str: string): string {
  return Buffer.from(str, "utf8").toString("hex").toUpperCase();
}

function rawHex(value: string): string {
  return (value.startsWith("0x") ? value.slice(2) : value).toUpperCase();
}

function buildMemo(key: string, value: string, isPayload = false) {
  let memoData: string;
  if (isPayload) {
    memoData = rawHex(value);
  } else if (key === "destination_address") {
    memoData = utf8Hex(value.replace(/^0x/, ""));
  } else {
    memoData = utf8Hex(value);
  }
  return { Memo: { MemoType: utf8Hex(key), MemoData: memoData } };
}

function hashEnvelope(e: any): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32","bytes32","address","address","uint8","uint256","uint64","uint64","bytes","uint16"],
      [e.intentId, e.xrplAccount, e.market, e.underlying,
       e.actionType, e.amount, e.nonce, e.deadline, e.destinationAddress, e.version]
    )
  );
}

function encodeSignedIntent(e: any, signature: string): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [SIGNED_INTENT_TUPLE],
    [[[e.intentId, e.xrplAccount, e.market, e.underlying,
       e.actionType, e.amount, e.nonce, e.deadline, e.destinationAddress, e.version],
      signature]]
  );
}

async function main() {
  const xrplSeed    = requiredEnv("XRPL_SEED");
  const evmRpcUrl   = requiredEnv("XRPL_EVM_RPC_URL");
  const intentKey   = requiredEnv("INTENT_SIGNER_PRIVATE_KEY");
  const adapterAddr = requiredEnv("XRPL_BRIDGE_ADAPTER");
  const market      = requiredEnv("XRPL_USDC_MARKET");
  const underlying  = requiredEnv("XRPL_USDC_UNDERLYING");
  const repayAmt    = requiredEnv("XRPL_USDC_REPAY_AMOUNT");
  const xrplRpc     = optionalEnv("XRPL_RPC_URL", "wss://s2.ripple.com");
  const gateway     = optionalEnv("XRPL_AXELAR_GATEWAY", "rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw");
  const destChain   = optionalEnv("XRPL_EVM_AXELAR_CHAIN", "xrpl-evm");
  const currency    = optionalEnv("XRPL_USDC_CURRENCY", "555344432E61786C000000000000000000000000");
  const issuer      = optionalEnv("XRPL_USDC_ISSUER", gateway);
  const gasFeeToken = optionalEnv("XRPL_USDC_GAS_FEE", "0");
  const confirmSend = process.env.XRPL_CONFIRM_SEND === "true";

  // sUSDC has 6 decimals on XRPL EVM -- confirmed convention (see docs/xrpl-evm-mainnet-deployment.md 5.4d).
  const repayAmountEVM = ethers.parseUnits(repayAmt, 6);
  const totalIouValue = (parseFloat(repayAmt) + parseFloat(gasFeeToken)).toString();

  const xrplWallet = Wallet.fromSeed(xrplSeed);
  const provider   = new ethers.JsonRpcProvider(evmRpcUrl);
  const network    = await provider.getNetwork();
  const adapter    = new ethers.Contract(adapterAddr, ADAPTER_ABI, provider);
  const evmSigner  = new ethers.Wallet(intentKey, provider);

  const xrplAccount  = ethers.keccak256(ethers.toUtf8Bytes(xrplWallet.address));
  const nonce        = BigInt(await adapter.nextNonceByXrplAccount(xrplAccount));
  const configSigner = await adapter.intentSignerOfXrplAccount(xrplAccount);

  if (configSigner.toLowerCase() !== evmSigner.address.toLowerCase()) {
    throw new Error(`Signer mismatch: adapter=${configSigner}, local=${evmSigner.address}`);
  }

  const marketConfig = await adapter.marketConfigOf(market);
  if (!marketConfig.listed) throw new Error(`Market not listed: ${market}`);
  if (marketConfig.underlying.toLowerCase() !== underlying.toLowerCase()) {
    throw new Error(`Underlying mismatch: expected ${underlying}, adapter has ${marketConfig.underlying}`);
  }
  console.log(`Adapter tokenId for this market: ${marketConfig.tokenId}`);

  const intentId = ethers.keccak256(
    ethers.toUtf8Bytes(`xrpl-usdc-repay:${xrplWallet.address}:${nonce}:${Date.now()}`)
  );

  const envelope = {
    intentId,
    xrplAccount,
    market,
    underlying,
    actionType: 2,   // REPAY
    amount: repayAmountEVM,
    nonce,
    deadline: BigInt(0),
    destinationAddress: "0x",  // no egress for REPAY
    version: 1
  };

  const payloadHash = hashEnvelope(envelope);
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address","uint256","bytes32"],
      [adapterAddr, network.chainId, payloadHash]
    )
  );
  const signature = await evmSigner.signMessage(ethers.getBytes(digest));
  const payload   = encodeSignedIntent(envelope, signature);

  const iouAmount: IssuedCurrencyAmount = {
    currency,
    issuer,
    value: totalIouValue,
  };

  const tx: Payment = {
    TransactionType: "Payment",
    Account:     xrplWallet.address,
    Amount:      iouAmount,
    Destination: gateway,
    Memos: [
      buildMemo("type",                "interchain_transfer"),
      buildMemo("destination_address", adapterAddr),
      buildMemo("destination_chain",   destChain),
      buildMemo("gas_fee_amount",      gasFeeToken),
      buildMemo("payload",             payload, true),
    ]
  };

  console.log(JSON.stringify({
    dryRun: !confirmSend,
    xrplSender:      xrplWallet.address,
    xrplAccount,
    market,
    underlying,
    repayAmount:     repayAmt,
    gasFeeToken,
    totalIouSent:    totalIouValue,
    repayAmountEVM:  repayAmountEVM.toString(),
    currency,
    issuer,
    nonce:           nonce.toString(),
    intentId,
    payment: { ...tx, Memos: "[redacted]" }
  }, null, 2));

  if (!confirmSend) {
    console.log("\nSet XRPL_CONFIRM_SEND=true to submit.");
    return;
  }

  const MAX_FEE_DROPS = 10_000;
  const client = new Client(xrplRpc);
  await client.connect();
  try {
    const prepared = await client.autofill(tx);
    const fee = parseInt((prepared as any).Fee ?? "0", 10);
    if (fee > MAX_FEE_DROPS) {
      throw new Error(`Autofill fee ${fee} drops exceeds safety cap of ${MAX_FEE_DROPS} drops`);
    }
    const signed = xrplWallet.sign(prepared);
    console.log("\nSubmitting...");
    const result = await client.submitAndWait(signed.tx_blob);
    const res = (result as any).result;
    console.log(JSON.stringify({ hash: res.hash, result: res.meta?.TransactionResult }, null, 2));
    console.log(`\nXRPL tx:  https://livenet.xrpl.org/transactions/${res.hash}`);
    console.log(`Axelar:   https://axelarscan.io/gmp/${res.hash.toLowerCase()}`);
  } finally {
    await client.disconnect();
  }
}

main().catch(e => { console.error(e.message ?? e); process.exitCode = 1; });
