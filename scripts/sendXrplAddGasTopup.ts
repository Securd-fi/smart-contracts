/**
 * Sends a standalone Axelar "Add Gas" top-up (native XRP) for an already-submitted,
 * underfunded XRPL -> XRPL EVM bridge message. Use when a message shows
 * is_insufficient_fee=true on Axelarscan.
 *
 * Required env vars:
 *   XRPL_SEED           XRPL mainnet wallet seed (same sender as the original message)
 *   ADD_GAS_MSG_ID       Original message tx hash, lowercase, no 0x prefix
 *   ADD_GAS_DROPS         Amount to send, in drops
 *
 * Optional:
 *   XRPL_RPC_URL         default: wss://s2.ripple.com (mainnet)
 *   XRPL_AXELAR_GATEWAY  default: rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw (mainnet)
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

async function main() {
  const xrplSeed = requiredEnv("XRPL_SEED");
  const msgId = requiredEnv("ADD_GAS_MSG_ID").toLowerCase().replace(/^0x/, "");
  const drops = requiredEnv("ADD_GAS_DROPS");
  const xrplRpc = optionalEnv("XRPL_RPC_URL", "wss://s2.ripple.com");
  const gateway = optionalEnv("XRPL_AXELAR_GATEWAY", "rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw");

  const wallet = Wallet.fromSeed(xrplSeed);
  const client = new Client(xrplRpc);
  await client.connect();
  try {
    const tx: Payment = {
      TransactionType: "Payment",
      Account: wallet.address,
      Amount: drops,
      Destination: gateway,
      Memos: [
        { Memo: { MemoType: utf8Hex("type"), MemoData: utf8Hex("add_gas") } },
        { Memo: { MemoType: utf8Hex("msg_id"), MemoData: utf8Hex(msgId) } },
      ],
    };

    console.log(JSON.stringify({ sender: wallet.address, gateway, msgId, drops }, null, 2));

    const MAX_FEE_DROPS = 10_000;
    const prepared = await client.autofill(tx);
    const fee = parseInt((prepared as any).Fee ?? "0", 10);
    if (fee > MAX_FEE_DROPS) {
      throw new Error(`Autofill fee ${fee} drops exceeds safety cap of ${MAX_FEE_DROPS} drops`);
    }
    const signed = wallet.sign(prepared);
    console.log("Submitting Add Gas...");
    const result = await client.submitAndWait(signed.tx_blob);
    const res = (result as any).result;
    console.log(JSON.stringify({ hash: res.hash, result: res.meta?.TransactionResult }, null, 2));
    console.log(`\nAdd Gas tx: https://livenet.xrpl.org/transactions/${res.hash}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
