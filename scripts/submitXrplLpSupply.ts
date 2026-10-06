/**
 * Sends a SUPPLY (DEPOSIT) intent for the XRP/USDC AMM LP token from XRPL Ledger mainnet
 * to XRPL EVM mainnet sXRPUSDCLP. Based on submitXrplUsdcSupply.ts.
 *
 * The XRPL wallet that sends the Payment is the USER's own wallet (the developer's test
 * wallet), not the team operator wallet. The user's XRPL account must already have its
 * intent signer registered on the bridge adapter (setIntentSigner), and that signer's key
 * is INTENT_SIGNER_PRIVATE_KEY.
 *
 * Amount scaling: the LP token has 15 decimals on XRPL EVM. The envelope amount is
 * parseUnits(value, 15). Example: "0.001" LP = 1000000000000 raw.
 *
 * Required env vars:
 *   XRPL_SEED                    the user's own XRPL wallet seed (kept in a gitignored env file)
 *   XRPL_EVM_RPC_URL             XRPL EVM RPC endpoint, e.g. https://rpc.xrplevm.org
 *   INTENT_SIGNER_PRIVATE_KEY    the intent signer key registered for this XRPL account
 *   XRPL_LP_SUPPLY_AMOUNT        amount of LP to supply, human-readable (e.g. "0.001")
 *
 * Optional (defaults are the mainnet values):
 *   XRPL_RPC_URL                 default wss://s2.ripple.com
 *   XRPL_AXELAR_GATEWAY          default rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw
 *   XRPL_EVM_AXELAR_CHAIN        default xrpl-evm
 *   XRPL_BRIDGE_ADAPTER          default 0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848
 *   XRPL_LP_MARKET               default sXRPUSDCLP 0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F
 *   XRPL_LP_UNDERLYING           default LP token 0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53
 *   XRPL_LP_TOKEN_ID             default 0xe2f2d147cc5da2f15c947b85d9a0bd88dc7e64bf864725a76b064002a06e291b
 *   XRPL_LP_CURRENCY             default 03B20F3A7D26D33C6DA3503E5CCE3E67B102D4D2
 *   XRPL_LP_ISSUER               default rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE (XRP/USDC AMM account)
 *   XRPL_LP_GAS_FEE              gas fee in LP IOU units, default "0" (top up with add-gas if needed)
 *   XRPL_CONFIRM_SEND            set to "true" to submit; anything else is a dry run
 *
 * Safety:
 *   - Dry run by default. Nothing is sent unless XRPL_CONFIRM_SEND=true.
 *   - Refuses if the adapter's signer for this XRPL account is not INTENT_SIGNER_PRIVATE_KEY's address.
 *   - Refuses if the market is not listed, the underlying does not match, or the token ID does not match the expected value.
 *   - An intent envelope cannot be changed once sent. Check the dry-run output before confirming.
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

const DEFAULT_ADAPTER = "0xa214Bf573c25fFa2d99d26e55fC023f2f0dcD848";
const DEFAULT_MARKET = "0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F";
const DEFAULT_UNDERLYING = "0xbAF2e0ef5D0dD17646F85129892E40fAA8065f53";
const DEFAULT_TOKEN_ID = "0xe2f2d147cc5da2f15c947b85d9a0bd88dc7e64bf864725a76b064002a06e291b";
const DEFAULT_LP_CURRENCY = "03B20F3A7D26D33C6DA3503E5CCE3E67B102D4D2";
const DEFAULT_LP_ISSUER = "rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE";
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
  const supplyAmt = requiredEnv("XRPL_LP_SUPPLY_AMOUNT");
  const xrplRpc = optionalEnv("XRPL_RPC_URL", "wss://s2.ripple.com");
  const gateway = optionalEnv("XRPL_AXELAR_GATEWAY", "rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw");
  const destChain = optionalEnv("XRPL_EVM_AXELAR_CHAIN", "xrpl-evm");
  const adapterAddr = optionalEnv("XRPL_BRIDGE_ADAPTER", DEFAULT_ADAPTER);
  const market = optionalEnv("XRPL_LP_MARKET", DEFAULT_MARKET);
  const underlying = optionalEnv("XRPL_LP_UNDERLYING", DEFAULT_UNDERLYING);
  const expectedTokenId = optionalEnv("XRPL_LP_TOKEN_ID", DEFAULT_TOKEN_ID);
  const currency = optionalEnv("XRPL_LP_CURRENCY", DEFAULT_LP_CURRENCY);
  const issuer = optionalEnv("XRPL_LP_ISSUER", DEFAULT_LP_ISSUER);
  const gasFeeToken = optionalEnv("XRPL_LP_GAS_FEE", "0");
  const confirmSend = process.env.XRPL_CONFIRM_SEND === "true";

  // LP token: 15 decimals on XRPL EVM. "0.001" LP = 1000000000000 raw.
  const supplyAmountEVM = ethers.parseUnits(supplyAmt, LP_DECIMALS);
  const totalIouValue = (parseFloat(supplyAmt) + parseFloat(gasFeeToken)).toString();

  const xrplWallet = Wallet.fromSeed(xrplSeed);
  const provider = new ethers.JsonRpcProvider(evmRpcUrl);
  const network = await provider.getNetwork();
  const adapter = new ethers.Contract(adapterAddr, ADAPTER_ABI, provider);
  const evmSigner = new ethers.Wallet(intentKey, provider);

  const xrplAccount = ethers.keccak256(ethers.toUtf8Bytes(xrplWallet.address));
  const nonce = BigInt(await adapter.nextNonceByXrplAccount(xrplAccount));
  const configSigner = await adapter.intentSignerOfXrplAccount(xrplAccount);

  if (configSigner.toLowerCase() !== evmSigner.address.toLowerCase()) {
    throw new Error(`Signer mismatch: adapter=${configSigner}, local=${evmSigner.address}`);
  }

  const marketConfig = await adapter.marketConfigOf(market);
  if (!marketConfig.listed) throw new Error(`Market not listed: ${market}`);
  if (marketConfig.underlying.toLowerCase() !== underlying.toLowerCase()) {
    throw new Error(`Underlying mismatch: expected ${underlying}, adapter has ${marketConfig.underlying}`);
  }
  if (marketConfig.tokenId.toLowerCase() !== expectedTokenId.toLowerCase()) {
    throw new Error(`Token ID mismatch: expected ${expectedTokenId}, adapter has ${marketConfig.tokenId}`);
  }

  const intentId = ethers.keccak256(
    ethers.toUtf8Bytes(`xrpl-lp-supply:${xrplWallet.address}:${nonce}:${Date.now()}`)
  );

  const envelope = {
    intentId,
    xrplAccount,
    market,
    underlying,
    actionType: 0, // SUPPLY
    amount: supplyAmountEVM,
    nonce,
    deadline: BigInt(0),
    destinationAddress: optionalEnv("XRPL_LP_INTENT_DESTINATION", "0x"),
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

  const iouAmount: IssuedCurrencyAmount = {
    currency,
    issuer,
    value: totalIouValue,
  };

  const tx: Payment = {
    TransactionType: "Payment",
    Account: xrplWallet.address,
    Amount: iouAmount,
    Destination: gateway,
    Memos: [
      buildMemo("type", "interchain_transfer"),
      buildMemo("destination_address", adapterAddr),
      buildMemo("destination_chain", destChain),
      buildMemo("gas_fee_amount", gasFeeToken),
      buildMemo("payload", payload, true),
    ]
  };

  console.log(JSON.stringify({
    dryRun: !confirmSend,
    xrplSender: xrplWallet.address,
    xrplAccount,
    market,
    underlying,
    tokenId: marketConfig.tokenId,
    supplyAmount: supplyAmt,
    gasFeeToken,
    totalIouSent: totalIouValue,
    supplyAmountEVM: supplyAmountEVM.toString(),
    currency,
    issuer,
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
    console.log("\nWait ~30-60 seconds for the Axelar relayer to execute SUPPLY on XRPL EVM.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
