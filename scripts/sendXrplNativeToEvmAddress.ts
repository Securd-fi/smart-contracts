/**
 * Sends native XRP from XRPL Ledger mainnet to an arbitrary address on XRPL EVM mainnet,
 * via a plain Axelar ITS interchain_transfer (no signed intent payload -- same pattern as
 * the earlier LP dust canary). Use this to top up an EVM contract's native XRP balance
 * (e.g. the bridge adapter's egress gas reserve), not to interact with the lending markets.
 *
 * Required env vars:
 *   XRPL_SEED               XRPL mainnet wallet seed (the sender)
 *   XRPL_NATIVE_AMOUNT_DROPS Amount to send, in drops
 *   XRPL_EVM_DESTINATION     EVM address to receive the native XRP
 *
 * Optional:
 *   XRPL_RPC_URL             default wss://s2.ripple.com
 *   XRPL_AXELAR_GATEWAY      default rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw
 *   XRPL_EVM_AXELAR_CHAIN    default xrpl-evm
 *   XRPL_GAS_FEE_DROPS       gas fee in drops on top of the transfer, default "0"
 *   XRPL_CONFIRM_SEND        set to "true" to submit; anything else is a dry run
 */
import { Client, Payment, Wallet } from "xrpl";

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

function buildMemo(key: string, value: string) {
  let memoData: string;
  if (key === "destination_address") {
    memoData = utf8Hex(value.replace(/^0x/, ""));
  } else {
    memoData = utf8Hex(value);
  }
  return { Memo: { MemoType: utf8Hex(key), MemoData: memoData } };
}

async function main() {
  const xrplSeed = requiredEnv("XRPL_SEED");
  const amountDrops = requiredEnv("XRPL_NATIVE_AMOUNT_DROPS");
  const destinationEvm = requiredEnv("XRPL_EVM_DESTINATION");
  const xrplRpc = optionalEnv("XRPL_RPC_URL", "wss://s2.ripple.com");
  const gateway = optionalEnv("XRPL_AXELAR_GATEWAY", "rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw");
  const destChain = optionalEnv("XRPL_EVM_AXELAR_CHAIN", "xrpl-evm");
  const gasFeeDrops = optionalEnv("XRPL_GAS_FEE_DROPS", "0");
  const confirmSend = process.env.XRPL_CONFIRM_SEND === "true";

  const wallet = Wallet.fromSeed(xrplSeed);
  const totalDrops = (BigInt(amountDrops) + BigInt(gasFeeDrops)).toString();

  const tx: Payment = {
    TransactionType: "Payment",
    Account: wallet.address,
    Amount: totalDrops,
    Destination: gateway,
    Memos: [
      buildMemo("type", "interchain_transfer"),
      buildMemo("destination_address", destinationEvm),
      buildMemo("destination_chain", destChain),
      buildMemo("gas_fee_amount", gasFeeDrops)
    ]
  };

  console.log(JSON.stringify({
    dryRun: !confirmSend,
    sender: wallet.address,
    destinationEvm,
    amountDrops,
    gasFeeDrops,
    totalDrops,
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
    if (fee > MAX_FEE_DROPS) throw new Error(`Autofill fee ${fee} drops exceeds safety cap of ${MAX_FEE_DROPS} drops`);
    const signed = wallet.sign(prepared);
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

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
