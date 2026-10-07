/**
 * Raises (or sets) the XRPL trust line limit for the XRP/USDC AMM LP currency, from the
 * holder's own account. This does not move any funds -- it only changes how much of this
 * currency the account is willing to hold, which is what blocked the LP WITHDRAW delivery
 * (see docs/lp-xrp-usdc-transaction-log.md): the line was auto-created by AMMDeposit with
 * limit 0, which refused the Axelar gateway's inbound delivery (tecPATH_DRY).
 *
 * Required env vars:
 *   XRPL_SEED                 XRPL mainnet wallet seed (the holder, e.g. rPAdN2a4...)
 *   XRPL_LP_TRUST_LIMIT        New limit, human-readable (e.g. "1000000000")
 *
 * Optional:
 *   XRPL_RPC_URL               default wss://s2.ripple.com
 *   XRPL_LP_CURRENCY           default 03B20F3A7D26D33C6DA3503E5CCE3E67B102D4D2
 *   XRPL_LP_ISSUER             default rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE
 *   XRPL_CONFIRM_SEND          set to "true" to submit; anything else is a dry run
 */
import { Client, Wallet, TrustSet } from "xrpl";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}

function optionalEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

async function main() {
  const xrplSeed = requiredEnv("XRPL_SEED");
  const newLimit = requiredEnv("XRPL_LP_TRUST_LIMIT");
  const xrplRpc = optionalEnv("XRPL_RPC_URL", "wss://s2.ripple.com");
  const currency = optionalEnv("XRPL_LP_CURRENCY", "03B20F3A7D26D33C6DA3503E5CCE3E67B102D4D2");
  const issuer = optionalEnv("XRPL_LP_ISSUER", "rM7cHVPfhe9yxQNk2kDNBEQqoQmMcQGPWE");
  const confirmSend = process.env.XRPL_CONFIRM_SEND === "true";

  const wallet = Wallet.fromSeed(xrplSeed);

  const tx: TrustSet = {
    TransactionType: "TrustSet",
    Account: wallet.address,
    LimitAmount: { currency, issuer, value: newLimit }
  };

  console.log(JSON.stringify({ dryRun: !confirmSend, account: wallet.address, currency, issuer, newLimit, tx }, null, 2));

  if (!confirmSend) {
    console.log("\nDry run. Set XRPL_CONFIRM_SEND=true to submit.");
    return;
  }

  const client = new Client(xrplRpc);
  await client.connect();
  try {
    const prepared = await client.autofill(tx);
    const fee = parseInt((prepared as any).Fee ?? "0", 10);
    if (fee > 1000) throw new Error(`Autofill fee ${fee} drops exceeds safety cap of 1000 drops`);
    const signed = wallet.sign(prepared);
    console.log("\nSubmitting...");
    const result = await client.submitAndWait(signed.tx_blob);
    const res = (result as any).result;
    console.log(JSON.stringify({ hash: res.hash, result: res.meta?.TransactionResult }, null, 2));
    console.log(`\nXRPL tx: https://livenet.xrpl.org/transactions/${res.hash}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
