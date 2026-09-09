import type { HardhatUserConfig } from 'hardhat/config';
import hardhatToolboxViem from '@nomicfoundation/hardhat-toolbox-viem';

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViem],
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
