/**
 * The chain, for real.
 *
 * `FakeChain` next door is a good simulator of the failure modes and a poor
 * simulator of an EVM. It never ran out of gas, never saw a nonce collide,
 * never reverted with a custom error, and never once refused a mint because the
 * identity it was minting to had no account bound. Everything below exists
 * because a real node does all of those.
 *
 * The shape is unchanged: the Token Service still calls `mintBatch` and
 * `recordResale` and still knows nothing about chains. What changes is that a
 * receipt now means a block.
 *
 * ── Identity, and where the address comes from ──────────────────────────────
 *
 * `TicketNFT.mintTo` refuses an identity with no bound account, deliberately: a
 * ticket minted to nobody opens no gate. So every identity needs an address
 * before its first ticket, and that address is derived here from a platform
 * seed rather than created by the fan.
 *
 * That is custodial, and it matters less than it sounds. These tokens cannot be
 * transferred — `approve` reverts, and `_update` is overridden so the only way a
 * ticket moves is `controllerTransfer` under the resale rules. The chain is not
 * holding a bearer asset somebody could lose or be phished out of; it is holding
 * a public, tamper-evident record of who was entitled to what and what the terms
 * were. The address is an identifier in that record, not a wallet.
 *
 * It is still a real limitation and should be stated as one: on this design the
 * platform can rebind an identity, and a fan cannot take their ticket somewhere
 * else. A non-custodial variant is a different product, not a later sprint.
 */
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { ChainUnavailable, ChainUncertain } from './client.js';
import type { ChainClient, MintReceipt, MintRequest, ResaleRequest, RevokeRequest } from './client.js';

/**
 * Only the functions this client calls.
 *
 * Hand-written rather than imported from `artifacts/`, which is build output and
 * gitignored — a fresh clone would have no ABI at all. `abi-drift.test.ts` in
 * packages/contracts asserts every entry here still matches the compiled
 * contract, so the copy cannot drift in silence.
 */
export const REGISTRY_ABI = [
  { type: 'function', name: 'accountOf', stateMutability: 'view', inputs: [{ name: 'identityId', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'bind', stateMutability: 'nonpayable', inputs: [{ name: 'identityId', type: 'bytes32' }, { name: 'account', type: 'address' }], outputs: [] },
] as const;

export const FACTORY_ABI = [
  { type: 'function', name: 'ticketContractOf', stateMutability: 'view', inputs: [{ name: '', type: 'bytes32' }], outputs: [{ type: 'address' }] },
] as const;

export const CONTROLLER_ABI = [
  { type: 'function', name: 'list', stateMutability: 'nonpayable', inputs: [{ name: 'ticketContract', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'sellerIdentity', type: 'bytes32' }, { name: 'price', type: 'uint96' }], outputs: [{ name: 'listingId', type: 'uint256' }] },
  { type: 'function', name: 'buy', stateMutability: 'nonpayable', inputs: [{ name: 'listingId', type: 'uint256' }, { name: 'buyerIdentity', type: 'bytes32' }, { name: 'expectedPrice', type: 'uint96' }], outputs: [{ name: 'saleId', type: 'bytes32' }] },
  { type: 'event', name: 'Listed', inputs: [{ name: 'listingId', type: 'uint256', indexed: true }, { name: 'tokenId', type: 'uint256', indexed: true }, { name: 'sellerIdentity', type: 'bytes32', indexed: true }, { name: 'price', type: 'uint96', indexed: false }] },
] as const;

export const TICKET_ABI = [
  { type: 'function', name: 'mintTo', stateMutability: 'nonpayable', inputs: [{ name: 'identityId', type: 'bytes32' }, { name: 'tierId', type: 'uint16' }], outputs: [{ name: 'tokenId', type: 'uint256' }] },
  { type: 'function', name: 'controllerTransfer', stateMutability: 'nonpayable', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'toIdentity', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'reason', type: 'string' }], outputs: [] },
  { type: 'event', name: 'TicketMinted', inputs: [{ name: 'tokenId', type: 'uint256', indexed: true }, { name: 'identityId', type: 'bytes32', indexed: true }, { name: 'tierId', type: 'uint16', indexed: true }] },
] as const;

export interface EvmChainOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  /** Signs every transaction. The minter and registrar on the deployed stack. */
  readonly privateKey: Hex;
  readonly accessRegistry: Address;
  readonly eventFactory: Address;
  /** The only contract allowed to move a ticket, and the one that enforces the terms. */
  readonly resaleController: Address;
  /** Derives the per-identity address. Never leaves this process. */
  readonly identitySeed: string;
  /** How long to wait for a receipt before giving up and retrying later. */
  readonly confirmTimeoutMs?: number;
}

/**
 * A domain id as the contracts see it.
 *
 * keccak of the string rather than a padded copy, so an id longer than 31 bytes
 * is representable and two different ids can never collide into the same word.
 */
export const toBytes32 = (id: string): Hex => keccak256(toHex(id));

export class EvmChain implements ChainClient {
  readonly #pub: PublicClient;
  readonly #wallet: WalletClient;
  readonly #account: ReturnType<typeof privateKeyToAccount>;
  readonly #opts: EvmChainOptions;
  /** Event id → ticket contract. Immutable once deployed, so cacheable forever. */
  readonly #ticketContracts = new Map<string, Address>();

  constructor(options: EvmChainOptions) {
    this.#opts = options;
    const chain = defineChain({
      id: options.chainId,
      name: `chain-${options.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [options.rpcUrl] } },
    });
    this.#account = privateKeyToAccount(options.privateKey);
    this.#pub = createPublicClient({ chain, transport: http(options.rpcUrl) });
    this.#wallet = createWalletClient({ account: this.#account, chain, transport: http(options.rpcUrl) });
  }

  get signerAddress(): Address {
    return this.#account.address;
  }

  async health(): Promise<{ up: boolean; chainId?: number }> {
    try {
      const chainId = await this.#pub.getChainId();
      // A node that answers for a different chain is worse than one that does
      // not answer: it will accept transactions that mean nothing here.
      if (chainId !== this.#opts.chainId) return { up: false, chainId };
      return { up: true, chainId };
    } catch {
      return { up: false };
    }
  }

  /**
   * The address that holds this identity's tickets.
   *
   * Deterministic, so the same identity resolves to the same address on every
   * process and after every restart — there is no table to lose. The seed never
   * leaves this process and the derived key is never stored, because nothing
   * ever needs to sign as a fan: these tokens do not move by their holder's
   * hand.
   */
  addressFor(identityId: string): Address {
    const key = keccak256(toHex(`${this.#opts.identitySeed}:${identityId}`));
    return privateKeyToAccount(key).address;
  }

  async #ticketContract(eventId: string): Promise<Address> {
    const cached = this.#ticketContracts.get(eventId);
    if (cached) return cached;
    const address = (await this.#pub.readContract({
      address: this.#opts.eventFactory,
      abi: FACTORY_ABI,
      functionName: 'ticketContractOf',
      args: [toBytes32(eventId)],
    })) as Address;
    if (address === '0x0000000000000000000000000000000000000000') {
      // The event was never created on chain. Not a transient failure: retrying
      // will not help, and pretending otherwise fills the outbox forever.
      throw new ChainUnavailable(`no ticket contract for event ${eventId}`);
    }
    this.#ticketContracts.set(eventId, address);
    return address;
  }

  /** Bind an identity to its derived address, unless it already is. */
  async #ensureBound(identityId: string): Promise<void> {
    const id = toBytes32(identityId);
    const existing = (await this.#pub.readContract({
      address: this.#opts.accessRegistry,
      abi: REGISTRY_ABI,
      functionName: 'accountOf',
      args: [id],
    })) as Address;
    if (existing !== '0x0000000000000000000000000000000000000000') return;

    await this.#send({
      address: this.#opts.accessRegistry,
      abi: REGISTRY_ABI,
      functionName: 'bind',
      args: [id, this.addressFor(identityId)],
    });
  }

  /**
   * Mint, one transaction per ticket, in sequence.
   *
   * `mintBatch` is the interface's name and this is not yet a batch: `TicketNFT`
   * mints one at a time, so this is N transactions. Sequential rather than
   * parallel because they share a nonce, and viem's automatic nonce management
   * hands out the same number twice if two sends race — which on a local node
   * looks like a mysterious "nonce too low" and on a real one costs money.
   *
   * A partial batch is fine and expected. Every receipt returned is confirmed on
   * chain; anything missing stays pending in the outbox, keyed on ticket id, and
   * is retried. That is the whole reason the outbox exists.
   */
  async mintBatch(requests: readonly MintRequest[]): Promise<readonly MintReceipt[]> {
    const receipts: MintReceipt[] = [];
    for (const request of requests) {
      const ticketContract = await this.#ticketContract(request.eventId);
      await this.#ensureBound(request.identityId);

      const hash = await this.#send({
        address: ticketContract,
        abi: TICKET_ABI,
        functionName: 'mintTo',
        args: [toBytes32(request.identityId), request.tierIndex],
      });

      const receipt = await this.#confirm(hash);
      const tokenId = this.#mintedTokenId(receipt);
      if (tokenId === undefined) {
        // The transaction landed and did not emit the event it must emit. Do
        // not invent a token id: leave it pending and let a human look.
        throw new ChainUnavailable(`mint for ${request.ticketId} emitted no TicketMinted`);
      }
      receipts.push({ ticketId: request.ticketId, tokenId: tokenId.toString(), txHash: hash });
    }
    return receipts;
  }

  async recordResale(request: ResaleRequest): Promise<{ txHash: string }> {
    if (!request.tokenId) {
      // The caller knows whether the mint has confirmed; this only knows what
      // it was told. Refusing loudly keeps the row pending for a retry rather
      // than sending a transfer of token zero.
      throw new ChainUnavailable(`resale for ${request.ticketId} has no token id — its mint has not confirmed`);
    }
    const ticketContract = await this.#ticketContract(request.eventId);
    await this.#ensureBound(request.toIdentityId);

    /*
     * A sale, not a transfer.
     *
     * The first version of this called `controllerTransfer` directly and the
     * contract refused it — correctly, and the refusal is the whole product.
     * Only the ResaleController may move a ticket, because moving one through
     * the controller is what applies the price ceiling, the resale window, the
     * cooldown and the maximum-resale count, and what records the royalty split
     * on chain. Transferring around it would reproduce the thing these
     * contracts exist to prevent: a ticket changing hands on terms the organizer
     * never agreed to.
     *
     * So the platform opens a listing in the seller's name and closes it for the
     * buyer. Two transactions, and every rule is enforced by the chain between
     * them rather than asserted by us.
     */
    const tokenId = BigInt(request.tokenId);
    const price = BigInt(request.priceMinor);

    const listHash = await this.#send({
      address: this.#opts.resaleController,
      abi: CONTROLLER_ABI,
      functionName: 'list',
      args: [ticketContract, tokenId, toBytes32(request.fromIdentityId), price],
    });
    const listed = await this.#confirm(listHash);
    const listingId = this.#listedId(listed);
    if (listingId === undefined) {
      throw new ChainUnavailable(`listing for ${request.ticketId} emitted no Listed event`);
    }

    const hash = await this.#send({
      address: this.#opts.resaleController,
      abi: CONTROLLER_ABI,
      functionName: 'buy',
      args: [listingId, toBytes32(request.toIdentityId), price],
    });
    await this.#confirm(hash);
    return { txHash: hash };
  }

  async revoke(request: RevokeRequest): Promise<{ txHash: string }> {
    if (!request.tokenId) {
      throw new ChainUnavailable(`revocation of ${request.ticketId} has no token id — its mint has not confirmed`);
    }
    /*
     * Callable because the minter may revoke, not only the admin.
     *
     * TicketNFT used to take its admin from `msg.sender`, which meant the
     * EventFactory that deployed it became the admin — a contract with no
     * function that calls revoke(). Every ticket the product ever issued was
     * unrevokable on chain, under a green test suite that deployed the contract
     * directly and so never saw it.
     */
    const hash = await this.#send({
      address: await this.#ticketContract(request.eventId),
      abi: TICKET_ABI,
      functionName: 'revoke',
      args: [BigInt(request.tokenId), request.reason],
    });
    await this.#confirm(hash);
    return { txHash: hash };
  }

  /** The listing id out of the Listed log. */
  #listedId(receipt: { logs: readonly { topics: readonly Hex[] }[] }): bigint | undefined {
    const signature = keccak256(toHex('Listed(uint256,uint256,bytes32,uint96)'));
    for (const log of receipt.logs) {
      if (log.topics[0] === signature && log.topics[1]) return BigInt(log.topics[1]);
    }
    return undefined;
  }

  async #send(call: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<Hex> {
    try {
      /*
       * Simulated first, and this is not belt and braces.
       *
       * `simulateContract` runs the call against current state and reverts with
       * the contract's own error — TierSoldOut, IdentityNotBound, NotMinter —
       * before any gas is spent. Sending blind turns every one of those into a
       * receipt with status 'reverted' and no reason, which is the difference
       * between an operator knowing the tier is full and an operator seeing a
       * transaction hash that did nothing.
       */
      const { request } = await this.#pub.simulateContract({
        account: this.#account,
        address: call.address,
        abi: call.abi as never,
        functionName: call.functionName as never,
        args: call.args as never,
      });
      return await this.#wallet.writeContract(request as never);
    } catch (e) {
      throw new ChainUnavailable((e as Error).message.split('\n')[0] ?? 'send failed');
    }
  }

  async #confirm(hash: Hex) {
    try {
      const receipt = await this.#pub.waitForTransactionReceipt({
        hash,
        timeout: this.#opts.confirmTimeoutMs ?? 60_000,
      });
      /*
       * A revert is a definite answer, and a safe one to retry: the transaction
       * was mined and changed nothing, so no token exists.
       */
      if (receipt.status !== 'success') throw new ChainUnavailable(`${hash}: transaction reverted`);
      return receipt;
    } catch (e) {
      if (e instanceof ChainUnavailable) throw e;
      /*
       * Anything else here — a timeout above all — means the transaction is out
       * there with an unknown fate. Reporting it as unavailable would put the
       * row back in the queue and mint the ticket twice.
       */
      throw new ChainUncertain(hash, (e as Error).message.split('\n')[0] ?? 'no receipt');
    }
  }

  /** The token id out of the TicketMinted log, which is where the truth is. */
  #mintedTokenId(receipt: { logs: readonly { topics: readonly Hex[] }[] }): bigint | undefined {
    // topic0 is the event signature; topic1 is the indexed tokenId.
    const signature = keccak256(toHex('TicketMinted(uint256,bytes32,uint16)'));
    for (const log of receipt.logs) {
      if (log.topics[0] === signature && log.topics[1]) return BigInt(log.topics[1]);
    }
    return undefined;
  }
}
