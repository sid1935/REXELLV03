/**
 * Deploy the stack, and write down where it went.
 *
 *   npx hardhat run scripts/deploy.ts --network localhost
 *   npx hardhat run scripts/deploy.ts --network sepolia
 *
 * Until this file existed, `packages/contracts` compiled and passed 42 tests and
 * had never once been deployed. The API reported its chain as `simulated` and
 * meant it: there was nothing to connect to, and no way to make one.
 *
 * What it writes is as important as what it deploys. `deployments/<chainId>.json`
 * is the file the API reads to find the addresses, so the deploy and the runtime
 * agree by construction rather than by somebody pasting an address into an
 * environment variable and getting one character wrong.
 *
 * ⚠ Four roles are set to the deployer here: admin, registrar, minter and gate.
 * That is correct for a local chain and wrong everywhere else — on a real
 * network the minter is the API's key, the gate is the attestation uploader, and
 * the admin should be a multisig that can take both away. `--roles` accepts
 * those addresses; the defaults exist so a local run is one command.
 */
import { network } from 'hardhat';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const { viem } = await network.connect();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
if (!deployer) throw new Error('No wallet client. Is the network configured with an account?');

const chainId = await publicClient.getChainId();
const from = deployer.account.address;

// Each role defaults to the deployer, which is right for a local chain and
// stated loudly for every other one.
const registrar = (argOf('registrar') ?? from) as `0x${string}`;
const minter = (argOf('minter') ?? from) as `0x${string}`;
const gate = (argOf('gate') ?? from) as `0x${string}`;

console.log(`\n  chain    ${chainId}`);
console.log(`  deployer ${from}`);
const balance = await publicClient.getBalance({ address: from });
console.log(`  balance  ${Number(balance) / 1e18} ETH\n`);
if (balance === 0n) {
  console.error('  The deployer has no funds. Nothing can be deployed.\n');
  process.exit(1);
}

const registry = await viem.deployContract('AccessRegistry', [registrar]);
console.log(`  AccessRegistry   ${registry.address}`);

const controller = await viem.deployContract('ResaleController', [registry.address, minter]);
console.log(`  ResaleController ${controller.address}`);

const splitter = await viem.deployContract('RoyaltySplitter', [controller.address]);
console.log(`  RoyaltySplitter  ${splitter.address}`);

const factory = await viem.deployContract('EventFactory', [registry.address, minter, gate, controller.address]);
console.log(`  EventFactory     ${factory.address}`);

// The controller cannot pay royalties until it knows where to send them, and a
// deploy that leaves this unset looks fine right up to the first resale.
await controller.write.setSplitter([splitter.address]);
console.log('\n  wired: controller -> splitter');

/*
 * The addresses, where the API will look for them.
 *
 * Keyed by chain id, so a machine that has deployed to a local node and to a
 * testnet keeps both and cannot accidentally point production at localhost.
 */
const out = resolve(here, '..', 'deployments', `${chainId}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify(
    {
      chainId,
      deployedAt: new Date().toISOString(),
      deployer: from,
      roles: { registrar, minter, gate },
      addresses: {
        accessRegistry: registry.address,
        resaleController: controller.address,
        royaltySplitter: splitter.address,
        eventFactory: factory.address,
      },
    },
    null,
    2,
  )}\n`,
);

console.log(`\n  wrote ${out}\n`);
if (registrar === from && chainId !== 31337) {
  console.log('  ⚠ Every role is the deployer key. On a real network, split them.\n');
}
