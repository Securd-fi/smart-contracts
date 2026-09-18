/**
 * Sends a BORROW intent for USDC from XRPL Ledger to XRPL EVM via Axelar GMP
 * (call_contract). Adapted from submitXrplBorrow.ts, which hardcodes 18-decimal
 * (parseEther) scaling appropriate only for native XRP -- sUSDC has 6 decimals, so a
 * borrow amount must use ethers.parseUnits(value, 6) or the raw on-chain borrow() call
 * receives a wildly wrong amount (same class of bug documented in
 * docs/xrpl-evm-mainnet-deployment.md section 5.4c for SUPPLY).
 *
 * BORROW is a GMP call_contract action (no token bridged inbound); the borrowed USDC is
 * pushed back to the XRPL destination address afterward via the adapter's _egress()
 * (same mechanism proven for WITHDRAW), which requires the adapter to hold at least
 * egressGasValue in native XRP up front.
 *
 * Required env vars:
 *   XRPL_SEED                 XRPL mainnet wallet seed
 *   XRPL_EVM_RPC_URL          XRPL EVM RPC endpoint
 *   DEPLOYER_PRIVATE_KEY      Intent signer private key
 *   XRPL_BRIDGE_ADAPTER       XRPLSecurdBridgeAdapter address
 *   XRPL_USDC_MARKET          sUSDC cToken address
 *   XRPL_USDC_UNDERLYING      USDC ERC-20 address on XRPL EVM
 *   XRPL_USDC_BORROW_AMOUNT   Amount to borrow as human-readable string (e.g. "0.01")
 *
 * Optional:
 *   XRPL_RPC_URL              default: wss://s2.ripple.com (mainnet)
 *   XRPL_AXELAR_GATEWAY       default: rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw (mainnet)
 *   XRPL_EVM_AXELAR_CHAIN     default: xrpl-evm
 *   XRPL_GMP_GAS_DROPS        default: 30000 (from scripts/estimateXrplBridgeGasFee.ts)
 *   XRPL_CONFIRM_SEND         Set to "true" to submit
 */
import { ethers } from "ethers";
import { Client, Payment, Wallet } from "xrpl";

const SIGNED_INTENT_TUPLE =
  "tuple(tuple(bytes32,bytes32,address,address,uint8,uint256,uint64,uint64,bytes,uint16),bytes)";

const ADAPTER_ABI = [
  "function nextNonceByXrplAccount(bytes32) view returns (uint64)",
  "function intentSignerOfXrplAccount(bytes32) view returns (address)",
  "function marketConfigOf(address) view returns (address underlying, bytes32 tokenId, bool listed)",
  "function egressGasValue() view returns (uint256)"
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
  const intentKey   = requiredEnv("DEPLOYER_PRIVATE_KEY");
  const adapterAddr = requiredEnv("XRPL_BRIDGE_ADAPTER");
  const market      = requiredEnv("XRPL_USDC_MARKET");
  const underlying  = requiredEnv("XRPL_USDC_UNDERLYING");
  const borrowAmt   = requiredEnv("XRPL_USDC_BORROW_AMOUNT");
  const xrplRpc     = optionalEnv("XRPL_RPC_URL", "wss://s2.ripple.com");
  const gateway     = optionalEnv("XRPL_AXELAR_GATEWAY", "rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw");
  const destChain   = optionalEnv("XRPL_EVM_AXELAR_CHAIN", "xrpl-evm");
  const gasDrops    = BigInt(optionalEnv("XRPL_GMP_GAS_DROPS", "30000"));
  const confirmSend = process.env.XRPL_CONFIRM_SEND === "true";

  // sUSDC has 6 decimals on XRPL EVM -- NOT parseEther (18 decimals, correct only for XRP).
  const borrowAmountEVM = ethers.parseUnits(borrowAmt, 6);

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

  const egressGas = await adapter.egressGasValue();
  const adapterBal = await provider.getBalance(adapterAddr);
  if (adapterBal < egressGas) {
    throw new Error(`Adapter has ${ethers.formatEther(adapterBal)} XRP native but needs ${ethers.formatEther(egressGas)} XRP for egress -- fund it first`);
  }

  const intentId = ethers.keccak256(
    ethers.toUtf8Bytes(`xrpl-usdc-borrow:${xrplWallet.address}:${nonce}:${Date.now()}`)
  );
  const destinationAddress = ethers.hexlify(ethers.toUtf8Bytes(xrplWallet.address));

  const envelope = {
    intentId,
    xrplAccount,
    market,
    underlying,
    actionType: 1,  // BORROW
    amount: borrowAmountEVM,
    nonce,
    deadline: BigInt(0),
    destinationAddress,
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

  const tx: Payment = {
    TransactionType: "Payment",
    Account:     xrplWallet.address,
    Amount:      gasDrops.toString(),
    Destination: gateway,
    Memos: [
      buildMemo("type",                "call_contract"),
      buildMemo("destination_address", adapterAddr),
      buildMemo("destination_chain",   destChain),
      buildMemo("payload",             payload, true)
    ]
  };

  console.log(JSON.stringify({
    dryRun: !confirmSend,
    xrplAccount: xrplWallet.address,
    action: "BORROW",
    market,
    underlying,
    borrowAmount: borrowAmt,
    borrowAmountEVM: borrowAmountEVM.toString(),
    adapterEgressGasXRP: ethers.formatEther(egressGas),
    adapterBalanceXRP: ethers.formatEther(adapterBal),
    nonce: nonce.toString(),
    intentId,
    gasDrops: gasDrops.toString()
  }, null, 2));

  if (!confirmSend) {
    console.log("Dry run -- set XRPL_CONFIRM_SEND=true to submit.");
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
    const result = await client.submitAndWait(signed.tx_blob);
    const res = (result as any).result;
    console.log(JSON.stringify({ hash: res.hash, result: res.meta?.TransactionResult }, null, 2));
    console.log(`XRPL tx:  https://livenet.xrpl.org/transactions/${res.hash}`);
    console.log(`Axelar:   https://axelarscan.io/gmp/${res.hash.toLowerCase()}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
