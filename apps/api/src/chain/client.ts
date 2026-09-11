/**
 * The chain, behind an interface.
 *
 * Two implementations: a real one talking to an L2, and `FakeChain` for tests.
 * The interface is narrow on purpose — the only thing above it that knows a
 * chain exists is the Token Service, so swapping L2s, or running with no chain
 * at all, changes one file.
 *
 * Every method may throw. That is not an exceptional case to be logged and
 * forgotten: it is the normal state of a sequencer during an incident, and the
 * outbox is built around it.
 */

export interface MintRequest {
  readonly ticketId: string;
  readonly eventId: string;
  readonly identityId: string;
  readonly tierIndex: number;
}

export interface MintReceipt {
  readonly ticketId: string;
  readonly tokenId: string;
  readonly txHash: string;
}

export interface ResaleRequest {
  readonly settlementId: string;
  readonly eventId: string;
  readonly ticketId: string;
  /** Who is selling. The on-chain listing is opened in their name. */
  readonly fromIdentityId: string;
  readonly toIdentityId: string;
  readonly priceMinor: number;
  /**
   * The ERC-721 the ticket became when its mint confirmed.
   *
   * Passed in rather than looked up, because the only place it exists is the
   * application database and a chain client that reads the database is a chain
   * client that cannot be tested without one. The caller has the repo; this
   * interface should stay something you can implement against a node and
   * nothing else.
   *
   * Absent until the mint confirms, and that is the normal case rather than an
   * error: the ledger lags the sale, always. A resale whose mint has not landed
   * stays pending and is retried, which is exactly what the outbox is for.
   */
  readonly tokenId?: string;
}

export interface ChainClient {
  /** Batched, because one transaction per ticket is a bad trade at onsale volume. */
  mintBatch(requests: readonly MintRequest[]): Promise<readonly MintReceipt[]>;
  recordResale(request: ResaleRequest): Promise<{ txHash: string }>;
  health(): Promise<{ up: boolean; chainId?: number }>;
}

export class ChainUnavailable extends Error {
  constructor(cause: string) {
    super(`chain unavailable: ${cause}`);
    this.name = 'ChainUnavailable';
  }
}

/**
 * An in-process stand-in.
 *
 * It exists to make the failure modes testable: `stop()` simulates a sequencer
 * outage, `failNext()` simulates a reverted transaction. A chain client you
 * cannot break is a chain client whose error handling is untested.
 */
export class FakeChain implements ChainClient {
  #up = true;
  #failures = 0;
  #nonce = 0;
  #minted = new Map<string, string>();

  readonly calls: { mintBatch: number; recordResale: number } = { mintBatch: 0, recordResale: 0 };

  stop(): void {
    this.#up = false;
  }
  start(): void {
    this.#up = true;
  }
  /** Fail the next `n` operations, then behave. Models a transient revert. */
  failNext(n: number): void {
    this.#failures = n;
  }
  get mintedCount(): number {
    return this.#minted.size;
  }
  tokenIdFor(ticketId: string): string | undefined {
    return this.#minted.get(ticketId);
  }

  #guard(): void {
    if (!this.#up) throw new ChainUnavailable('sequencer is down');
    if (this.#failures > 0) {
      this.#failures -= 1;
      throw new ChainUnavailable('transaction reverted');
    }
  }

  async mintBatch(requests: readonly MintRequest[]): Promise<readonly MintReceipt[]> {
    this.calls.mintBatch += 1;
    this.#guard();
    const txHash = `0x${(++this.#nonce).toString(16).padStart(64, '0')}`;
    return requests.map((r, i) => {
      const tokenId = String(this.#minted.size + i + 1);
      this.#minted.set(r.ticketId, tokenId);
      return { ticketId: r.ticketId, tokenId, txHash };
    });
  }

  async recordResale(_request: ResaleRequest): Promise<{ txHash: string }> {
    this.calls.recordResale += 1;
    this.#guard();
    return { txHash: `0x${(++this.#nonce).toString(16).padStart(64, '0')}` };
  }

  async health(): Promise<{ up: boolean; chainId?: number }> {
    return this.#up ? { up: true, chainId: 31337 } : { up: false };
  }
}
