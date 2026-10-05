import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "solidity-coverage";

const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY;
const xrplEvmRpcUrl = process.env.XRPL_EVM_RPC_URL;
const forkMainnetRpcUrl = process.env.XRPL_EVM_MAINNET_FORK_RPC;

const xrplEvmNetwork = xrplEvmRpcUrl
  ? {
      xrplEvm: {
        url: xrplEvmRpcUrl,
        chainId: Number(process.env.XRPL_EVM_CHAIN_ID || 1440002),
        accounts: deployerPrivateKey ? [deployerPrivateKey] : []
      }
    }
  : {};

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      // Pinned explicitly for Blockscout verification: solc auto-selects "paris" for 0.8.24 by default
      // (confirmed via `hardhat compile` output, "evm target: paris"), but leaving it implicit means
      // Blockscout's own recompilation during verification can't be certain it's using the same target,
      // which silently produces different bytecode and fails verification with no useful error message.
      evmVersion: "paris"
    }
  },
  networks: {
    // Lets test/integration/adapterRegistrarGateFork.spec.ts fork XRPL EVM mainnet: EDR has no built-in
    // hardfork history for this non-standard chain id, and without declaring one it refuses to execute
    // against any forked historical block ("No known hardfork for execution..."). XRPL EVM mainnet
    // compiles/runs as the Paris EVM target (confirmed via `hardhat compile` output, "evm target: paris")
    // -- Hardhat's own hardfork enum names that same post-Merge ruleset "merge", not "paris" (Solidity and
    // Hardhat/EDR use different names for identical EVM semantics). Only takes effect when
    // XRPL_EVM_MAINNET_FORK_RPC is set, so the default local "hardhat" network used by every other test is
    // unaffected; `hardhat_reset` at runtime does not reliably pick up `chains` config set this way, so the
    // fork is configured statically here instead.
    hardhat: {
      hardfork: "merge",
      chains: {
        1440000: {
          hardforkHistory: {
            merge: 0
          }
        }
      },
      ...(forkMainnetRpcUrl ? { forking: { url: forkMainnetRpcUrl } } : {})
    },
    ...xrplEvmNetwork
  },
  // Blockscout source verification (explorer.xrplevm.org) via `npx hardhat verify`. Blockscout's
  // Etherscan-compatible API doesn't check the API key value, but hardhat-verify requires the field to be
  // a non-empty string, so any placeholder works -- there is no real secret here.
  etherscan: {
    apiKey: {
      xrplEvm: "blockscout-no-api-key-required"
    },
    customChains: [
      {
        network: "xrplEvm",
        chainId: Number(process.env.XRPL_EVM_CHAIN_ID || 1440000),
        urls: {
          apiURL: "https://explorer.xrplevm.org/api",
          browserURL: "https://explorer.xrplevm.org"
        }
      }
    ]
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  mocha: {
    timeout: 120000
  }
};

export default config;
