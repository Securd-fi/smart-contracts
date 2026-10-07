/**
 * Sends a WITHDRAW intent for the XRP/USDC AMM LP token from XRPL EVM back to XRPL Ledger
 * mainnet, via Axelar GMP (call_contract). Adapted from submitXrplWithdraw.ts, which hardcodes
 * ethers.parseEther (18-decimal) scaling appropriate only for native XRP -- the LP token has
 * 15 decimals, so a withdraw amount must use ethers.parseUnits(value, 15) or the on-chain
 * redeemUnderlying() call receives a wildly wrong amount (same class of bug documented in
 * docs/xrpl-evm-mainnet-deployment.md section 5.4c for SUPPLY, and already found once for
 * BORROW -- see docs/xrpl-evm-mainnet-dapp-developer-guide.md).
 *
 * This is the critical, previously-unproven leg: it is the ONLY path that brings LP collateral
 * back out to XRPL Ledger (EVM -> XRPL, 15-decimal IOU). If it fails, LP deposited by users stays
 * stuck on the EVM side.
 *
 * On XRPL EVM the adapter:
 *   1. Validates the gateway approval and intent signature
 *   2. Calls proxy.redeemUnderlying(amount) on the user's sXRPUSDCLP position
 *   3. Pulls the redeemed LP token back to the adapter
 *   4. Sends it back to the XRPL account via ITS interchainTransfer
 *
 * Required env vars:
 *   XRPL_SEED                   XRPL mainnet wallet seed
 *   XRPL_EVM_RPC_URL             XRPL EVM RPC endpoint
 *   INTENT_SIGNER_PRIVATE_KEY    Intent signer private key (registered via setIntentSigner)
 *   XRPL_LP_WITHDRAW_AMOUNT      Amount of LP to withdraw, human-readable (e.g. "0.5")
 *
 * Optional (defaults are the mainnet values):
 *   XRPL_RPC_URL                 default wss://s2.ripple.com
 *   XRPL_AXELAR_GATEWAY          default rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw
 *   XRPL_EVM_AXELAR_CHAIN        default xrpl-evm
 *   XRPL_BRIDGE_ADAPTER          default 0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848
 *   XRPL_LP_MARKET               default sXRPUSDCLP 0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F
 *   XRPL_LP_UNDERLYING           default LP token 0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53
 *   XRPL_GMP_GAS_DROPS           default 30000 (proven sufficient for GMP actions in this test)
 *   XRPL_LP_WITHDRAW_DESTINATION default: the sender's own XRPL address
 *   XRPL_CONFIRM_SEND            set to "true" to submit; anything else is a dry run
 *
 * Safety:
 *   - Dry run by default.
 *   - Refuses if the adapter's signer for this XRPL account is not INTENT_SIGNER_PRIVATE_KEY's address.
 *   - Refuses if the market is not listed or the underlying does not match.
 *   - An intent envelope cannot be changed once sent.
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

const DEFAULT_ADAPTER = "0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848";
const DEFAULT_MARKET = "0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F";
const DEFAULT_UNDERLYING = "0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53";
const LP_DECIMALS = 15;

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
      ["bytes32", "bytes32", "address", "address", "uint8", "uint256", "uint64", "uint64", "bytes", "uint16"],
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
  const xrplSeed = requiredEnv("XRPL_SEED");
  const evmRpcUrl = requiredEnv("XRPL_EVM_RPC_URL");
  const intentKey = requiredEnv("INTENT_SIGNER_PRIVATE_KEY");
  const withdrawAmt = requiredEnv("XRPL_LP_WITHDRAW_AMOUNT");
  const xrplRpc = optionalEnv("XRPL_RPC_URL", "wss://s2.ripple.com");
  const gateway = optionalEnv("XRPL_AXELAR_GATEWAY", "rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw");
  const destChain = optionalEnv("XRPL_EVM_AXELAR_CHAIN", "xrpl-evm");
  const adapterAddr = optionalEnv("XRPL_BRIDGE_ADAPTER", DEFAULT_ADAPTER);
  const market = optionalEnv("XRPL_LP_MARKET", DEFAULT_MARKET);
  const underlying = optionalEnv("XRPL_LP_UNDERLYING", DEFAULT_UNDERLYING);
  const gmpGasDrops = BigInt(optionalEnv("XRPL_GMP_GAS_DROPS", "30000"));
  const confirmSend = process.env.XRPL_CONFIRM_SEND === "true";

  // LP token: 15 decimals on XRPL EVM. "0.5" LP = 500000000000000 raw. NOT parseEther.
  const withdrawAmountEVM = ethers.parseUnits(withdrawAmt, LP_DECIMALS);

  const xrplWallet = Wallet.fromSeed(xrplSeed);
  const provider = new ethers.JsonRpcProvider(evmRpcUrl);
  const network = await provider.getNetwork();
  const evmSigner = new ethers.Wallet(intentKey, provider);
  const adapter = new ethers.Contract(adapterAddr, ADAPTER_ABI, provider);

  const xrplAccount = ethers.keccak256(ethers.toUtf8Bytes(xrplWallet.address));
  const nonce = BigInt(await adapter.nextNonceByXrplAccount(xrplAccount));

  const configuredSigner = await adapter.intentSignerOfXrplAccount(xrplAccount);
  if (configuredSigner.toLowerCase() !== evmSigner.address.toLowerCase()) {
    throw new Error(`Signer mismatch: adapter=${configuredSigner}, local=${evmSigner.address}`);
  }

  const marketConfig = await adapter.marketConfigOf(market);
  if (!marketConfig.listed) throw new Error(`Market not listed: ${market}`);
  if (marketConfig.underlying.toLowerCase() !== underlying.toLowerCase()) {
    throw new Error(`Underlying mismatch: expected ${underlying}, adapter has ${marketConfig.underlying}`);
  }

  const egressGasValue = await adapter.egressGasValue();
  console.log("adapter egressGasValue:", ethers.formatEther(egressGasValue), "XRP");

  const intentId = ethers.keccak256(
    ethers.toUtf8Bytes(`xrpl-lp-withdraw:${xrplWallet.address}:${nonce.toString()}:${Date.now()}`)
  );

  const destinationXrplAddress = optionalEnv("XRPL_LP_WITHDRAW_DESTINATION", xrplWallet.address);
  const destinationAddressBytes = ethers.hexlify(ethers.toUtf8Bytes(destinationXrplAddress));

  const envelope = {
    intentId,
    xrplAccount,
    market,
    underlying,
    actionType: 3, // WITHDRAW
    amount: withdrawAmountEVM,
    nonce,
    deadline: BigInt(0),
    destinationAddress: destinationAddressBytes,
    version: 1
  };

  const payloadHash = hashEnvelope(envelope);
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "bytes32"],
      [adapterAddr, network.chainId, payloadHash]
    )
  );
  const signature = await evmSigner.signMessage(ethers.getBytes(digest));
  const payload = encodeSignedIntent(envelope, signature);

  // XRPL Payment: GMP call_contract -- only gas XRP, no token transfer inbound.
  const tx: Payment = {
    TransactionType: "Payment",
    Account: xrplWallet.address,
    Amount: gmpGasDrops.toString(),
    Destination: gateway,
    Memos: [
      buildMemo("type", "call_contract"),
      buildMemo("destination_address", adapterAddr),
      buildMemo("destination_chain", destChain),
      buildMemo("payload", payload, true)
    ]
  };

  console.log(JSON.stringify({
    dryRun: !confirmSend,
    xrplSender: xrplWallet.address,
    xrplAccount,
    market,
    underlying,
    withdrawAmountLP: withdrawAmt,
    withdrawAmountEVM: withdrawAmountEVM.toString(),
    returnDestination: destinationXrplAddress,
    gmpGasDrops: gmpGasDrops.toString(),
    nonce: nonce.toString(),
    intentId,
    payloadBytes: payload.length / 2 - 1,
    payment: { ...tx, Memos: "[redacted]" }
  }, null, 2));

  if (!confirmSend) {
    console.log("\nDry run. Set XRPL_CONFIRM_SEND=true to submit.");
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
    console.log("\nWait ~30-60 seconds for the Axelar relayer to execute WITHDRAW on XRPL EVM, then check");
    console.log("the XRPL LP trustline balance and the adapter's egress back to this account.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
