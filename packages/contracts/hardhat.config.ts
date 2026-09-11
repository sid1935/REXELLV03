import type { HardhatUserConfig } from 'hardhat/config';
import hardhatToolboxViem from '@nomicfoundation/hardhat-toolbox-viem';

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViem],

  /*
   * Networks.
   *
   * `localhost` is a node started with `hardhat node` — a real EVM with real
   * nonces, real reverts and real gas, which is the cheapest way to find out
   * that a client works against something FakeChain never modelled.
   *
   * The public networks read their RPC and key from the environment and are
   * absent from the config if it is unset, so a missing key is 'no such
   * network' at the start rather than a hang at the first transaction.
   */
  networks: {
    localhost: { type: 'http', url: 'http://127.0.0.1:8545', chainId: 31337 },
    ...(process.env.SEPOLIA_RPC_URL && process.env.DEPLOYER_KEY
      ? {
          sepolia: {
            type: 'http' as const,
            url: process.env.SEPOLIA_RPC_URL,
            chainId: 11155111,
            accounts: [process.env.DEPLOYER_KEY],
          },
        }
      : {}),
    ...(process.env.BASE_SEPOLIA_RPC_URL && process.env.DEPLOYER_KEY
      ? {
          baseSepolia: {
            type: 'http' as const,
            url: process.env.BASE_SEPOLIA_RPC_URL,
            chainId: 84532,
            accounts: [process.env.DEPLOYER_KEY],
          },
        }
      : {}),
  },
  solidity: {
    version: '0.8.28',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // TicketNFT's constructor takes the four trust-critical addresses plus the
      // policy hash and tier array, which overflows the legacy codegen's stack.
      // The IR pipeline handles it, and is the recommended path for 0.8.28.
      viaIR: true,
    },
  },
};

export default config;
