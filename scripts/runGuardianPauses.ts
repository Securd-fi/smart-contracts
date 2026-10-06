/**
 * Pause the XRP/USDC LP and ARMY LP markets, signed by the pause guardian.
 *
 * Calls (all on the Comptroller, directly, not through the timelock):
 *   1. _setBorrowPaused(sXRPUSDCLP, true)
 *   2. _setBorrowPaused(sXRPARMYLP, true)
 *   3. _setMintPaused(sXRPARMYLP, true)
 *
 * Key handling:
 *   - The key is read from GUARDIAN_PRIVATE_KEY in a local, gitignored env file
 *     (.env.mainnet.guardian-key). It is never printed and never written anywhere else.
 *   - Run with: set -a; . ./.env.mainnet.guardian-key; set +a; npx ts-node scripts/runGuardianPauses.ts
 *
 * Safety:
 *   - Refuses to run unless CONFIRM_GUARDIAN_PAUSES=true.
 *   - Refuses to run unless the key's address equals the Comptroller's pauseGuardian().
 *   - Skips any pause that is already in place, so a re-run is safe.
 *   - Reads each flag back after sending and fails if it is not set.
 *
 * Env:
 *   GUARDIAN_PRIVATE_KEY           required, pause guardian key (0x-prefixed or bare hex)
 *   CONFIRM_GUARDIAN_PAUSES        must be "true"
 *   XRPL_EVM_RPC_URL               default https://rpc.xrplevm.org
 *   XRPL_EVM_CHAIN_ID              default 1440000 (checked against the RPC)
 */
import { ethers } from "ethers";

const COMPTROLLER = "0xf2631D04bf1E568c777e822213040785B968405E";
const SXRPUSDCLP = "0xBC08F8E0cF29874a9C9C660cf5F045bD65F2270F";
const SXRPARMYLP = "0x48C2A0cA5a2780199ADd81BB7828612314Ae1728";
const EXPECTED_CHAIN_ID = 1440000n;

const COMPTROLLER_ABI = [
  "function pauseGuardian() view returns (address)",
  "function borrowGuardianPaused(address) view returns (bool)",
  "function mintGuardianPaused(address) view returns (bool)",
  "function _setBorrowPaused(address cToken, bool state) returns (bool)",
  "function _setMintPaused(address cToken, bool state) returns (bool)"
];

async function main(): Promise<void> {
  if (process.env.CONFIRM_GUARDIAN_PAUSES !== "true") {
    throw new Error("Set CONFIRM_GUARDIAN_PAUSES=true to send the transactions.");
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

  const guardian = await comptroller.pauseGuardian();
  if (wallet.address.toLowerCase() !== guardian.toLowerCase()) {
    throw new Error(`Key address ${wallet.address} is not the pauseGuardian ${guardian}. Refusing to send.`);
  }

  const balance = await provider.getBalance(wallet.address);
  console.log(`guardian ${wallet.address}, balance ${ethers.formatEther(balance)} XRP`);

  const steps: Array<{ label: string; check: () => Promise<boolean>; send: () => Promise<ethers.ContractTransactionResponse> }> = [
    {
      label: "borrow pause sXRPUSDCLP",
      check: () => comptroller.borrowGuardianPaused(SXRPUSDCLP),
      send: () => comptroller._setBorrowPaused(SXRPUSDCLP, true)
    },
    {
      label: "borrow pause sXRPARMYLP",
      check: () => comptroller.borrowGuardianPaused(SXRPARMYLP),
      send: () => comptroller._setBorrowPaused(SXRPARMYLP, true)
    },
    {
      label: "mint pause sXRPARMYLP",
      check: () => comptroller.mintGuardianPaused(SXRPARMYLP),
      send: () => comptroller._setMintPaused(SXRPARMYLP, true)
    }
  ];

  for (const step of steps) {
    if (await step.check()) {
      console.log(`[skip] ${step.label}: already paused`);
      continue;
    }
    const tx = await step.send();
    console.log(`[sent] ${step.label}: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`${step.label} failed: tx ${tx.hash} status ${receipt?.status}`);
    }
    if (!(await step.check())) {
      throw new Error(`${step.label}: transaction succeeded but the flag is still not set.`);
    }
    console.log(`[ok]   ${step.label}: confirmed in block ${receipt.blockNumber}`);
  }

  console.log("All three pauses are in place.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
