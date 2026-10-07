/**
 * Repays the full outstanding XRP borrow on sXRP for the test wallet, approving the
 * native XRP precompile underlying first.
 *
 * Key handling:
 *   - Uses DEPLOYER_PRIVATE_KEY from .env.mainnet (the same wallet that minted the LP
 *     and sent the borrow).
 *   - Run with: set -a; . ./.env.mainnet; set +a; CONFIRM_REPAY=true npx ts-node scripts/runRepayXrpBorrow.ts
 *
 * Safety:
 *   - Refuses to run unless CONFIRM_REPAY=true.
 *   - Reads the current borrow balance first; if it is 0, there is nothing to repay.
 *   - Approves exactly the current borrow balance (read fresh, since interest may have accrued).
 *   - Reads the borrow balance back after repaying and fails if it is not 0.
 */
import { ethers } from "ethers";

const SXRP = "0xEFedd95eFdB71652bd93F58b2B7F77748Dee04F6";
const XRP_UNDERLYING = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const EXPECTED_CHAIN_ID = 1440000n;

const CTOKEN_ABI = [
  "function borrowBalanceStored(address) view returns (uint256)",
  "function repayBorrow(uint256) returns (uint256)"
];
const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)"
];

async function main(): Promise<void> {
  if (process.env.CONFIRM_REPAY !== "true") {
    throw new Error("Set CONFIRM_REPAY=true to send the transactions.");
  }
  const rawKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!rawKey) throw new Error("DEPLOYER_PRIVATE_KEY is not set. Load it from .env.mainnet first.");

  const rpcUrl = process.env.XRPL_EVM_RPC_URL ?? "https://rpc.xrplevm.org";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`RPC chain id is ${network.chainId}, expected ${EXPECTED_CHAIN_ID}. Refusing to continue.`);
  }

  const wallet = new ethers.Wallet(rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`, provider);
  const sxrp = new ethers.Contract(SXRP, CTOKEN_ABI, wallet);
  const underlying = new ethers.Contract(XRP_UNDERLYING, ERC20_ABI, wallet);

  const owed = await sxrp.borrowBalanceStored(wallet.address);
  if (owed === 0n) {
    console.log("[skip] borrow balance is already 0. Nothing to repay.");
    return;
  }
  console.log(`Outstanding borrow: ${owed} wei (${ethers.formatEther(owed)} XRP)`);

  const approveTx = await underlying.approve(SXRP, owed);
  console.log(`[sent] approve: ${approveTx.hash}`);
  await approveTx.wait();

  const repayTx = await sxrp.repayBorrow(owed);
  console.log(`[sent] repayBorrow: ${repayTx.hash}`);
  const receipt = await repayTx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Repay failed: tx ${repayTx.hash} status ${receipt?.status}`);
  }

  const remaining = await sxrp.borrowBalanceStored(wallet.address);
  if (remaining !== 0n) {
    throw new Error(`Transaction succeeded but borrow balance is still ${remaining}, not 0.`);
  }
  console.log(`[ok] borrow fully repaid, confirmed in block ${receipt.blockNumber}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
