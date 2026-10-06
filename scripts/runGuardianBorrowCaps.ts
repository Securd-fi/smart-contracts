/**
 * Set the borrow caps for the USDC and XRP markets, signed by the borrow cap guardian.
 *
 * Call (on the Comptroller, directly, not through the timelock):
 *   _setMarketBorrowCaps([sUSDC, sXRP], [2000 USDC, 1000 XRP])
 *
 * Caps follow docs/lp-price-calculation-spec.md §9:
 *   sUSDC: 2,000 USDC  (raw 2000000000, 6 decimals)
 *   sXRP:  1,000 XRP   (raw 1000000000000000000000, 18 decimals)
 *
 * Key handling:
 *   - The key is read from GUARDIAN_PRIVATE_KEY in the local, gitignored env file
 *     (.env.mainnet.guardian-key). It is never printed and never written anywhere else.
 *   - Run with: set -a; . ./.env.mainnet.guardian-key; set +a; CONFIRM_GUARDIAN_BORROW_CAPS=true npx ts-node scripts/runGuardianBorrowCaps.ts
 *
 * Safety:
 *   - Refuses to run unless CONFIRM_GUARDIAN_BORROW_CAPS=true.
 *   - Refuses to run unless the key's address equals the Comptroller's borrowCapGuardian().
 *   - Refuses to run unless the RPC chain id is 1440000.
 *   - Reads the current caps first and skips the call if both already match.
 *   - Reads the caps back after sending and fails if either one is not set.
 *   - A cap of 0 means unlimited on this Comptroller, so both caps must be positive.
 *
 * Env:
 *   GUARDIAN_PRIVATE_KEY              required, borrow cap guardian key (same address as pauseGuardian)
 *   CONFIRM_GUARDIAN_BORROW_CAPS      must be "true"
 *   XRPL_EVM_RPC_URL                  default https://rpc.xrplevm.org
 */
import { ethers } from "ethers";

const COMPTROLLER = "0xf2631D04bf1E568c777e822213040785B968405E";
const SUSDC = "0x21Da09A16d69757C0731De3b83e65061BCF30E00";
const SXRP = "0xEFedd95eFdB71652bd93F58b2B7F77748Dee04F6";
const SUSDC_CAP = 2_000_000_000n; // 2,000 USDC, 6 decimals
const SXRP_CAP = 1_000_000_000_000_000_000_000n; // 1,000 XRP, 18 decimals
const EXPECTED_CHAIN_ID = 1440000n;

const COMPTROLLER_ABI = [
  "function borrowCapGuardian() view returns (address)",
  "function borrowCaps(address) view returns (uint256)",
  "function _setMarketBorrowCaps(address[] cTokens, uint256[] newBorrowCaps)"
];

async function main(): Promise<void> {
  if (process.env.CONFIRM_GUARDIAN_BORROW_CAPS !== "true") {
    throw new Error("Set CONFIRM_GUARDIAN_BORROW_CAPS=true to send the transaction.");
  }
  const rawKey = process.env.GUARDIAN_PRIVATE_KEY;
  if (!rawKey) {
    throw new Error("GUARDIAN_PRIVATE_KEY is not set. Load it from .env.mainnet.guardian-key first.");
  }

  const rpcUrl = process.env.XRPL_EVM_RPC_URL ?? "https://rpc.xrplevm.org";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`RPC chain id is ${network.chainId}, expected ${EXPECTED_CHAIN_ID}. Refusing to continue.`);
  }

  const wallet = new ethers.Wallet(rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`, provider);
  const comptroller = new ethers.Contract(COMPTROLLER, COMPTROLLER_ABI, wallet);

  const guardian = await comptroller.borrowCapGuardian();
  if (wallet.address.toLowerCase() !== guardian.toLowerCase()) {
    throw new Error(`Key address ${wallet.address} is not the borrowCapGuardian ${guardian}. Refusing to send.`);
  }

  const balance = await provider.getBalance(wallet.address);
  console.log(`guardian ${wallet.address}, balance ${ethers.formatEther(balance)} XRP`);

  const capsMatch = async (): Promise<boolean> =>
    (await comptroller.borrowCaps(SUSDC)) === SUSDC_CAP && (await comptroller.borrowCaps(SXRP)) === SXRP_CAP;

  if (await capsMatch()) {
    console.log("[skip] both borrow caps already set to the target values");
    return;
  }

  const tx = await comptroller._setMarketBorrowCaps([SUSDC, SXRP], [SUSDC_CAP, SXRP_CAP]);
  console.log(`[sent] set borrow caps: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`borrow cap transaction failed: tx ${tx.hash} status ${receipt?.status}`);
  }
  if (!(await capsMatch())) {
    throw new Error("transaction succeeded but the borrow caps do not match the targets.");
  }
  console.log(`[ok]   borrow caps set: sUSDC 2,000 USDC, sXRP 1,000 XRP, block ${receipt.blockNumber}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
