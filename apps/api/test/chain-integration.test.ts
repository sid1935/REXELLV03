import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CONTROLLER_ABI, EvmChain, FACTORY_ABI, toBytes32 } from '../src/chain/evm-chain.js';

/**
 * EvmChain against a real EVM.
 *
 * Everything else in this suite runs against FakeChain, which is the right
 * trade for testing the outbox: it can be stopped, reverted and made uncertain
 * on demand. What it cannot do is disagree with a contract, and every serious
 * bug in this client so far has been exactly that — an ABI that encoded
 * something the contract read differently, a token id guessed from a ticket id,
 * a transfer the contract was always going to refuse, a listing that could
 * never be reused. None of them were reachable without a node.
 *
 * So this file talks to one. It is skipped unless `REXELL_RPC_URL` is set,
 * which keeps `npm test` a fifteen-second loop on a laptop, and CI starts a
 * Hardhat node and sets it. Skipped is reported, not silent: a run with these
 * absent says so in the summary.
 */

const RPC = process.env['REXELL_RPC_URL'];
/** Hardhat's first account. A published test key; never a real one. */
const KEY = (process.env['REXELL_CHAIN_KEY'] ??
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as Hex;

const CHAIN_ID = Number(process.env['REXELL_CHAIN_ID'] ?? 31337);

/*
 * A skipped suite reports success, which is the same colour as a passing one.
 *
 * That is fine on a laptop and not fine in CI, where a typo in the environment
 * block would quietly turn this whole file off and leave a green tick claiming
 * the chain client is covered. So the job that means to run these says so, and
 * saying so without a node to talk to is an error rather than a skip.
 */
if (process.env['REXELL_CHAIN_REQUIRED'] && !RPC) {
  throw new Error('REXELL_CHAIN_REQUIRED is set but REXELL_RPC_URL is not — these tests would have skipped silently');
}

const GA = {
  mode: 1,
  maxPriceBps: 11_000,
  minPriceBps: 5_000,
  opensAt: 0n,
  closesAt: 4_102_444_800n,
  cooldown: 0,
  maxResales: 2,
  faceValue: 220_000n,
  allocation: 50,
  splits: { organizerBps: 700, platformBps: 300, rightsHolderBps: 200 },
};

const ADMIN_ABI = [
  { type: 'function', name: 'admin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
const VALID_ABI = [
  {
    type: 'function',
    name: 'isValidForEntry',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
] as const;
const IDENTITY_ABI = [
  {
    type: 'function',
    name: 'identityOf',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'bytes32' }],
  },
] as const;
const NEXT_LISTING_ABI = [
  { type: 'function', name: 'nextListingId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

describe.skipIf(!RPC)('EvmChain against a node', () => {
  let addresses: { accessRegistry: Address; eventFactory: Address; resaleController: Address };
  let pub: ReturnType<typeof createPublicClient>;
  let wallet: ReturnType<typeof createWalletClient>;
  let evm: EvmChain;
  let factoryAbi: readonly unknown[];

  /** Unique per test, because a chain keeps everything the last test did. */
  const fresh = (prefix: string) => `${prefix}_${Math.random().toString(16).slice(2, 10)}`;

  beforeAll(async () => {
    const file = resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'packages',
      'contracts',
      'deployments',
      `${CHAIN_ID}.json`,
    );
    addresses = JSON.parse(readFileSync(file, 'utf8')).addresses;

    // createEvent is not on the client's hand-written ABI — the API never
    // creates an event on chain, an operator does — so the artifact supplies it.
    factoryAbi = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '..', '..', '..', 'packages', 'contracts', 'artifacts', 'contracts', 'EventFactory.sol', 'EventFactory.json'),
        'utf8',
      ),
    ).abi;

    const chain = defineChain({
      id: CHAIN_ID,
      name: `chain-${CHAIN_ID}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [RPC!] } },
    });
    pub = createPublicClient({ chain, transport: http(RPC!) });
    wallet = createWalletClient({ account: privateKeyToAccount(KEY), chain, transport: http(RPC!) });

    evm = new EvmChain({
      rpcUrl: RPC!,
      chainId: CHAIN_ID,
      privateKey: KEY,
      accessRegistry: addresses.accessRegistry,
      eventFactory: addresses.eventFactory,
      resaleController: addresses.resaleController,
      identitySeed: 'ci-integration-seed',
    });
  });

  /** An event on chain, through the factory — the path production uses. */
  async function newEvent(): Promise<{ eventId: string; ticketContract: Address }> {
    const eventId = fresh('evt');
    const id32 = toBytes32(eventId);
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        address: addresses.eventFactory,
        abi: factoryAbi as never,
        functionName: 'createEvent',
        args: [id32, 'CI', 'CI', keccak256(toHex('policy')), 1000, [GA]],
        chain: null,
        account: privateKeyToAccount(KEY),
      }),
    });
    const ticketContract = (await pub.readContract({
      address: addresses.eventFactory,
      abi: FACTORY_ABI,
      functionName: 'ticketContractOf',
      args: [id32],
    })) as Address;
    return { eventId, ticketContract };
  }

  it('reports the chain it is actually talking to', async () => {
    const health = await evm.health();
    expect(health).toEqual({ up: true, chainId: CHAIN_ID });
  });

  it('mints a ticket the factory-deployed contract can still revoke', async () => {
    const { eventId, ticketContract } = await newEvent();

    /*
     * The regression that mattered most. TicketNFT took its admin from
     * `msg.sender`, and it is deployed by EventFactory — so the admin was the
     * factory, a contract with no function that calls revoke(). Every ticket
     * the product ever issued was unrevokable, under a green suite that
     * deployed the contract directly.
     */
    const admin = (await pub.readContract({
      address: ticketContract,
      abi: ADMIN_ABI,
      functionName: 'admin',
    })) as Address;
    expect(admin.toLowerCase()).not.toBe(addresses.eventFactory.toLowerCase());

    const ticketId = fresh('tkt');
    const [receipt] = await evm.mintBatch([{ ticketId, eventId, identityId: fresh('idn'), tierIndex: 0 }]);
    expect(receipt).toBeDefined();

    const tokenId = BigInt(receipt!.tokenId);
    const valid = () =>
      pub.readContract({ address: ticketContract, abi: VALID_ABI, functionName: 'isValidForEntry', args: [tokenId] });
    expect(await valid()).toBe(true);

    await evm.revoke({ ticketId, eventId, reason: 'chargeback', tokenId: receipt!.tokenId });
    expect(await valid()).toBe(false);
  });

  it('refuses a resale above the ceiling the organizer set', async () => {
    const { eventId } = await newEvent();
    const ticketId = fresh('tkt');
    const seller = fresh('idn');
    const [receipt] = await evm.mintBatch([{ ticketId, eventId, identityId: seller, tierIndex: 0 }]);

    // ₹2,420 is the cap on a ₹2,200 face value at 11,000bps.
    await expect(
      evm.recordResale({
        settlementId: fresh('set'),
        eventId,
        ticketId,
        fromIdentityId: seller,
        toIdentityId: fresh('idn'),
        priceMinor: 900_000,
        tokenId: receipt!.tokenId,
      }),
    ).rejects.toThrow();
  });

  it('finishes a resale whose listing already landed, without listing twice', async () => {
    const { eventId, ticketContract } = await newEvent();
    const ticketId = fresh('tkt');
    const seller = fresh('idn');
    const buyer = fresh('idn');
    const [receipt] = await evm.mintBatch([{ ticketId, eventId, identityId: seller, tierIndex: 0 }]);
    const tokenId = BigInt(receipt!.tokenId);
    const price = 242_000n;

    // The failure being modelled: `list` lands, `buy` never goes.
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        address: addresses.resaleController,
        abi: CONTROLLER_ABI,
        functionName: 'list',
        args: [ticketContract, tokenId, toBytes32(seller), price],
        chain: null,
        account: privateKeyToAccount(KEY),
      }),
    });

    const before = await pub.readContract({
      address: addresses.resaleController,
      abi: NEXT_LISTING_ABI,
      functionName: 'nextListingId',
    });

    await evm.recordResale({
      settlementId: fresh('set'),
      eventId,
      ticketId,
      fromIdentityId: seller,
      toIdentityId: buyer,
      priceMinor: Number(price),
      tokenId: receipt!.tokenId,
    });

    // It resumed from `buy`. Listing again would have reverted ListingNotActive
    // for ever, which is the bug: sold here, open there, closed by nobody.
    const after = await pub.readContract({
      address: addresses.resaleController,
      abi: NEXT_LISTING_ABI,
      functionName: 'nextListingId',
    });
    expect(after).toBe(before);

    const owner = await pub.readContract({
      address: ticketContract,
      abi: IDENTITY_ABI,
      functionName: 'identityOf',
      args: [tokenId],
    });
    expect(owner).toBe(toBytes32(buyer));
  });

  it('will not settle a listing that is not the sale it was asked to settle', async () => {
    const { eventId, ticketContract } = await newEvent();
    const ticketId = fresh('tkt');
    const seller = fresh('idn');
    const [receipt] = await evm.mintBatch([{ ticketId, eventId, identityId: seller, tierIndex: 0 }]);

    // An open listing at a different price. Reusing it would close somebody
    // else's trade on our terms.
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        address: addresses.resaleController,
        abi: CONTROLLER_ABI,
        functionName: 'list',
        args: [ticketContract, BigInt(receipt!.tokenId), toBytes32(seller), 230_000n],
        chain: null,
        account: privateKeyToAccount(KEY),
      }),
    });

    await expect(
      evm.recordResale({
        settlementId: fresh('set'),
        eventId,
        ticketId,
        fromIdentityId: seller,
        toIdentityId: fresh('idn'),
        priceMinor: 242_000,
        tokenId: receipt!.tokenId,
      }),
    ).rejects.toThrow(/not the sale being settled/);
  });
});
