import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { network } from 'hardhat';
import { computeSplits, minor } from '@rexell/domain';

/**
 * Contract tests.
 *
 * Most of these are adversarial: the exit criteria for this milestone are all of
 * the form "prove that an attack fails", so the tests are written as attacks
 * rather than as feature demonstrations.
 */

const BOUND = 0;
const CAPPED = 1;

const ZERO = '0x0000000000000000000000000000000000000000';
const ALICE_ID = '0x' + '11'.repeat(32);
const BOB_ID = '0x' + '22'.repeat(32);
const CAROL_ID = '0x' + '33'.repeat(32);
const POLICY_HASH = '0x' + 'ab'.repeat(32);

const FACE_GA = 220_000n; // ₹2,200.00 in paise
const FACE_VIP = 850_000n;

const SPLITS = { organizerBps: 700, platformBps: 300, rightsHolderBps: 200 };

function tier(overrides: Record<string, unknown> = {}) {
  return {
    mode: CAPPED,
    maxPriceBps: 11_000,
    minPriceBps: 5_000,
    opensAt: 0n,
    closesAt: 4_102_444_800n, // year 2100
    cooldown: 0,
    maxResales: 2,
    faceValue: FACE_GA,
    allocation: 100,
    splits: SPLITS,
    ...overrides,
  };
}

const GA = tier();
const VIP = tier({ mode: BOUND, faceValue: FACE_VIP, allocation: 10 });

describe('ReXell contracts', () => {
  let connection: any;
  let viem: any;
  let deployer: `0x${string}`;
  let aliceWallet: `0x${string}`;
  let bobWallet: `0x${string}`;
  let carolWallet: `0x${string}`;
  let attacker: `0x${string}`;

  let registry: any;
  let controller: any;
  let splitter: any;
  let ticketNFT: any;

  before(async () => {
    connection = await network.connect();
    viem = connection.viem;
    const wallets = await viem.getWalletClients();
    deployer = wallets[0]!.account.address;
    aliceWallet = wallets[1]!.account.address;
    bobWallet = wallets[2]!.account.address;
    carolWallet = wallets[3]!.account.address;
    attacker = wallets[4]!.account.address;
  });

  beforeEach(async () => {
    // The backend relayer is the operator and the minter. Fans hold no gas and
    // sign nothing; see the paymaster note in architecture §04.
    registry = await viem.deployContract('AccessRegistry', [deployer]);
    controller = await viem.deployContract('ResaleController', [registry.address, deployer]);
    splitter = await viem.deployContract('RoyaltySplitter', [controller.address]);
    await controller.write.setSplitter([splitter.address]);

    await registry.write.bind([ALICE_ID, aliceWallet]);
    await registry.write.bind([BOB_ID, bobWallet]);
    await registry.write.bind([CAROL_ID, carolWallet]);

    ticketNFT = await viem.deployContract('TicketNFT', [
      'Sunburn Weekender 2026',
      'SBW26',
      deployer, // minter
      deployer, // gate
      controller.address,
      registry.address,
      POLICY_HASH,
      1000,
      [GA, VIP],
    ]);
  });

  const mintGA = async (identity: string) => {
    await ticketNFT.write.mintTo([identity, 0]);
    return ticketNFT.read.nextTokenId().then((n: bigint) => n - 1n);
  };
  const mintVIP = async (identity: string) => {
    await ticketNFT.write.mintTo([identity, 1]);
    return ticketNFT.read.nextTokenId().then((n: bigint) => n - 1n);
  };

  // ─── registry ──────────────────────────────────────────────────────────────

  describe('AccessRegistry', () => {
    it('binds an identity to an account, both ways', async () => {
      assert.equal((await registry.read.accountOf([ALICE_ID])).toLowerCase(), aliceWallet.toLowerCase());
      assert.equal(await registry.read.identityOf([aliceWallet]), ALICE_ID);
      assert.equal(await registry.read.isBound([ALICE_ID]), true);
    });

    it('refuses to let two identities share one account', async () => {
      // Without the reverse check, a farm binds sixty pseudonyms to one wallet
      // and the per-identity purchase cap becomes a per-wallet cap.
      const other = '0x' + '99'.repeat(32);
      await assert.rejects(registry.write.bind([other, aliceWallet]), /AccountInUse/);
    });

    it('refuses to rebind an identity that was never bound', async () => {
      await assert.rejects(registry.write.bind([ALICE_ID, attacker]), /AlreadyBound/);
      await assert.rejects(registry.write.rebind(['0x' + '88'.repeat(32), attacker]), /NotBound/);
    });

    it('lets a fan recover after losing their phone', async () => {
      await registry.write.rebind([ALICE_ID, attacker]);
      assert.equal((await registry.read.accountOf([ALICE_ID])).toLowerCase(), attacker.toLowerCase());
      // And the old account is released, not left dangling.
      assert.equal(await registry.read.identityOf([aliceWallet]), '0x' + '00'.repeat(32));
    });

    it('only the registrar may bind', async () => {
      const asAttacker = await viem.getContractAt('AccessRegistry', registry.address, {
        client: { wallet: (await viem.getWalletClients())[4] },
      });
      await assert.rejects(asAttacker.write.bind(['0x' + '77'.repeat(32), attacker]), /NotRegistrar/);
    });
  });

  // ─── the exit criterion: a bound ticket cannot be transferred ─────────────

  describe('a bound ticket cannot be transferred by anybody', () => {
    it('reverts for the owner calling transferFrom directly', async () => {
      const tokenId = await mintVIP(ALICE_ID);
      const asAlice = await viem.getContractAt('TicketNFT', ticketNFT.address, {
        client: { wallet: (await viem.getWalletClients())[1] },
      });
      await assert.rejects(
        asAlice.write.transferFrom([aliceWallet, bobWallet, tokenId]),
        /TicketIsBound/,
      );
    });

    it('reverts for safeTransferFrom too', async () => {
      const tokenId = await mintVIP(ALICE_ID);
      const asAlice = await viem.getContractAt('TicketNFT', ticketNFT.address, {
        client: { wallet: (await viem.getWalletClients())[1] },
      });
      await assert.rejects(
        asAlice.write.safeTransferFrom([aliceWallet, bobWallet, tokenId]),
        /TicketIsBound/,
      );
    });

    it('reverts for the resale controller itself — bound means bound', async () => {
      // The controller is the privileged path for capped tiers. It must not be a
      // way around a bound one.
      const tokenId = await mintVIP(ALICE_ID);
      await assert.rejects(
        controller.write.list([ticketNFT.address, tokenId, ALICE_ID, FACE_VIP]),
        /ResaleDisabled/,
      );
    });

    it('reverts even for the contract admin', async () => {
      const tokenId = await mintVIP(ALICE_ID);
      await assert.rejects(ticketNFT.write.transferFrom([aliceWallet, bobWallet, tokenId]), /TicketIsBound/);
    });

    it('cannot be approved to anybody, so no marketplace can list it', async () => {
      const tokenId = await mintVIP(ALICE_ID);
      const asAlice = await viem.getContractAt('TicketNFT', ticketNFT.address, {
        client: { wallet: (await viem.getWalletClients())[1] },
      });
      await assert.rejects(asAlice.write.approve([attacker, tokenId]), /ApprovalsDisabled/);
      await assert.rejects(asAlice.write.setApprovalForAll([attacker, true]), /ApprovalsDisabled/);
    });
  });

  describe('a capped ticket cannot be transferred outside the controller either', () => {
    it('reverts when the owner tries to move it directly', async () => {
      const tokenId = await mintGA(ALICE_ID);
      const asAlice = await viem.getContractAt('TicketNFT', ticketNFT.address, {
        client: { wallet: (await viem.getWalletClients())[1] },
      });
      await assert.rejects(
        asAlice.write.transferFrom([aliceWallet, bobWallet, tokenId]),
        /TransfersMustGoThroughController/,
      );
    });

    it('reverts when anyone but the controller calls controllerTransfer', async () => {
      const tokenId = await mintGA(ALICE_ID);
      await assert.rejects(ticketNFT.write.controllerTransfer([tokenId, BOB_ID]), /NotController/);
    });
  });

  // ─── minting ───────────────────────────────────────────────────────────────

  describe('issuance', () => {
    it('mints to the account the identity is bound to', async () => {
      const tokenId = await mintGA(ALICE_ID);
      assert.equal((await ticketNFT.read.ownerOf([tokenId])).toLowerCase(), aliceWallet.toLowerCase());
      assert.equal(await ticketNFT.read.identityOf([tokenId]), ALICE_ID);
    });

    it('refuses to mint to an identity nobody is bound to', async () => {
      // A ticket minted to an unbound pseudonym belongs to nobody and opens no
      // gate. Better to fail here than to discover it at a turnstile.
      await assert.rejects(ticketNFT.write.mintTo(['0x' + 'ee'.repeat(32), 0]), /IdentityNotBound/);
    });

    it('only the minter may mint', async () => {
      const asAttacker = await viem.getContractAt('TicketNFT', ticketNFT.address, {
        client: { wallet: (await viem.getWalletClients())[4] },
      });
      await assert.rejects(asAttacker.write.mintTo([ALICE_ID, 0]), /NotMinter/);
    });

    it('will not oversell a tier', async () => {
      const small = await viem.deployContract('TicketNFT', [
        'Tiny',
        'TINY',
        deployer,
        deployer,
        controller.address,
        registry.address,
        POLICY_HASH,
        10,
        [tier({ allocation: 2 })],
      ]);
      await small.write.mintTo([ALICE_ID, 0]);
      await small.write.mintTo([BOB_ID, 0]);
      await assert.rejects(small.write.mintTo([CAROL_ID, 0]), /TierSoldOut/);
    });

    it('refuses at deploy time to allocate more than capacity', async () => {
      await assert.rejects(
        viem.deployContract('TicketNFT', [
          'Oversold',
          'OVER',
          deployer,
          deployer,
          controller.address,
          registry.address,
          POLICY_HASH,
          5,
          [tier({ allocation: 100 })],
        ]),
        /CapacityExceeded/,
      );
    });

    it('anchors the policy hash the organizer committed to', async () => {
      assert.equal(await ticketNFT.read.policyHash(), POLICY_HASH);
    });
  });

  // ─── the exit criterion: a resale above the ceiling reverts ────────────────

  describe('resale price bounds', () => {
    it('accepts a listing at exactly the ceiling', async () => {
      const tokenId = await mintGA(ALICE_ID);
      const ceiling = await ticketNFT.read.ceilingOf([0]);
      assert.equal(ceiling, 242_000n); // 110% of ₹2,200.00
      await controller.write.list([ticketNFT.address, tokenId, ALICE_ID, ceiling]);
    });

    it('reverts one paisa above the ceiling', async () => {
      const tokenId = await mintGA(ALICE_ID);
      await assert.rejects(
        controller.write.list([ticketNFT.address, tokenId, ALICE_ID, 242_001n]),
        /PriceAboveCeiling/,
      );
    });

    it('reverts below the floor — wash trading is not a resale', async () => {
      const tokenId = await mintGA(ALICE_ID);
      await assert.rejects(
        controller.write.list([ticketNFT.address, tokenId, ALICE_ID, 109_999n]),
        /PriceBelowFloor/,
      );
    });

    it('reverts when somebody lists a ticket they do not hold', async () => {
      const tokenId = await mintGA(ALICE_ID);
      await assert.rejects(
        controller.write.list([ticketNFT.address, tokenId, BOB_ID, 220_000n]),
        /NotTicketOwner/,
      );
    });

    it('reverts once the ticket has been flipped its maximum times', async () => {
      const limited = await viem.deployContract('TicketNFT', [
        'Limited',
        'LIM',
        deployer,
        deployer,
        controller.address,
        registry.address,
        POLICY_HASH,
        100,
        [tier({ maxResales: 1 })],
      ]);
      await limited.write.mintTo([ALICE_ID, 0]);

      const l1 = await controller.write.list([limited.address, 1n, ALICE_ID, 220_000n]);
      assert.ok(l1);
      await controller.write.buy([1n, BOB_ID, 220_000n]);

      // Bob now holds it with resaleCount 1, which is the cap.
      await assert.rejects(
        controller.write.list([limited.address, 1n, BOB_ID, 220_000n]),
        /ResaleLimitReached/,
      );
    });
  });

  // ─── the exit criterion: splits balance ───────────────────────────────────

  describe('splits balance exactly, and agree with the TypeScript', () => {
    it('matches the worked example from the business plan', async () => {
      const r = await splitter.read.preview([242_000n, SPLITS]);
      assert.equal(r.organizer, 16_940n);
      assert.equal(r.platform, 7_260n);
      assert.equal(r.rightsHolder, 4_840n);
      assert.equal(r.seller, 212_960n);
    });

    it('agrees with packages/domain across a sweep of awkward prices', async () => {
      // A differential test, not two independent guesses. If the Solidity and
      // the TypeScript ever diverge, the organizer's statement stops matching
      // the chain and somebody has to reconcile it by hand.
      const prices = [0, 1, 2, 3, 7, 99, 101, 999, 1_000, 12_345, 242_000, 999_999, 1_000_001];
      for (const price of prices) {
        const chain = await splitter.read.preview([BigInt(price), SPLITS]);
        const local = computeSplits(minor(price), SPLITS);

        assert.equal(chain.organizer, BigInt(local.organizer), `organizer at ${price}`);
        assert.equal(chain.platform, BigInt(local.platform), `platform at ${price}`);
        assert.equal(chain.rightsHolder, BigInt(local.rightsHolder), `rightsHolder at ${price}`);
        assert.equal(chain.seller, BigInt(local.seller), `seller at ${price}`);

        // And the invariant itself, on chain.
        assert.equal(
          chain.organizer + chain.platform + chain.rightsHolder + chain.seller,
          BigInt(price),
          `does not balance at ${price}`,
        );
      }
    });

    it('gives the rounding remainder to the seller, never the platform', async () => {
      const r = await splitter.read.preview([1n, SPLITS]);
      assert.equal(r.organizer, 0n);
      assert.equal(r.platform, 0n);
      assert.equal(r.rightsHolder, 0n);
      assert.equal(r.seller, 1n);
    });

    it('refuses a table allocating more than 100%', async () => {
      await assert.rejects(
        splitter.read.preview([1_000n, { organizerBps: 7_000, platformBps: 4_000, rightsHolderBps: 0 }]),
        /SplitsExceedTotal/,
      );
    });

    it('records each sale once', async () => {
      const tokenId = await mintGA(ALICE_ID);
      await controller.write.list([ticketNFT.address, tokenId, ALICE_ID, 242_000n]);
      await controller.write.buy([1n, BOB_ID, 242_000n]);
      // A second buy on the same listing cannot happen, so the saleId cannot repeat.
      await assert.rejects(controller.write.buy([1n, CAROL_ID, 242_000n]), /ListingNotActive/);
    });

    it('only the controller may record a split', async () => {
      await assert.rejects(
        splitter.write.record(['0x' + '01'.repeat(32), ticketNFT.address, 1n, 1_000n, SPLITS]),
        /NotAuthorised/,
      );
    });
  });

  // ─── the whole resale, and the revocation that matters ────────────────────

  describe('a resale rebinds the credential in the same transaction', () => {
    it('moves the ticket and the identity together', async () => {
      const tokenId = await mintGA(ALICE_ID);
      assert.equal(await ticketNFT.read.identityOf([tokenId]), ALICE_ID);

      await controller.write.list([ticketNFT.address, tokenId, ALICE_ID, 242_000n]);
      await controller.write.buy([1n, BOB_ID, 242_000n]);

      // The token moved...
      assert.equal((await ticketNFT.read.ownerOf([tokenId])).toLowerCase(), bobWallet.toLowerCase());
      // ...and so did the credential. Alice's face no longer opens this gate.
      assert.equal(await ticketNFT.read.identityOf([tokenId]), BOB_ID);

      const t = await ticketNFT.read.ticket([tokenId]);
      assert.equal(t.resaleCount, 1);
      // The cooldown clock restarted for the new owner.
      assert.ok(t.acquiredAt > 0n);
    });

    it('refuses a buyer whose identity is not bound', async () => {
      const tokenId = await mintGA(ALICE_ID);
      await controller.write.list([ticketNFT.address, tokenId, ALICE_ID, 242_000n]);
      await assert.rejects(controller.write.buy([1n, '0x' + 'dd'.repeat(32), 242_000n]), /BuyerNotBound/);
    });

    it('refuses to let a seller buy their own listing', async () => {
      const tokenId = await mintGA(ALICE_ID);
      await controller.write.list([ticketNFT.address, tokenId, ALICE_ID, 242_000n]);
      await assert.rejects(controller.write.buy([1n, ALICE_ID, 242_000n]), /CannotBuyOwnListing/);
    });

    it('refuses when the price moved under the buyer', async () => {
      const tokenId = await mintGA(ALICE_ID);
      await controller.write.list([ticketNFT.address, tokenId, ALICE_ID, 242_000n]);
      await assert.rejects(controller.write.buy([1n, BOB_ID, 220_000n]), /PriceChanged/);
    });

    it('only an operator may drive a sale', async () => {
      const tokenId = await mintGA(ALICE_ID);
      await controller.write.list([ticketNFT.address, tokenId, ALICE_ID, 242_000n]);
      const asAttacker = await viem.getContractAt('ResaleController', controller.address, {
        client: { wallet: (await viem.getWalletClients())[4] },
      });
      await assert.rejects(asAttacker.write.buy([1n, BOB_ID, 242_000n]), /NotOperator/);
    });

    it('cannot sell a listing twice', async () => {
      const tokenId = await mintGA(ALICE_ID);
      await controller.write.list([ticketNFT.address, tokenId, ALICE_ID, 242_000n]);
      await controller.write.buy([1n, BOB_ID, 242_000n]);
      await assert.rejects(controller.write.buy([1n, CAROL_ID, 242_000n]), /ListingNotActive/);
    });
  });

  // ─── the gate ──────────────────────────────────────────────────────────────

  describe('redemption and revocation', () => {
    it('redeems once and refuses a second time', async () => {
      const tokenId = await mintGA(ALICE_ID);
      await ticketNFT.write.redeem([tokenId]);
      assert.equal((await ticketNFT.read.ticket([tokenId])).redeemed, true);
      await assert.rejects(ticketNFT.write.redeem([tokenId]), /AlreadyRedeemed/);
    });

    it('will not redeem a revoked ticket', async () => {
      const tokenId = await mintGA(ALICE_ID);
      await ticketNFT.write.revoke([tokenId, 'chargeback']);
      await assert.rejects(ticketNFT.write.redeem([tokenId]), /TicketIsRevoked/);
      assert.equal(await ticketNFT.read.isValidForEntry([tokenId]), false);
    });

    it('will not resell a redeemed ticket', async () => {
      const tokenId = await mintGA(ALICE_ID);
      await ticketNFT.write.redeem([tokenId]);
      await assert.rejects(
        controller.write.list([ticketNFT.address, tokenId, ALICE_ID, 242_000n]),
        /TicketNotListable/,
      );
    });

    it('only the gate may redeem', async () => {
      const tokenId = await mintGA(ALICE_ID);
      const asAttacker = await viem.getContractAt('TicketNFT', ticketNFT.address, {
        client: { wallet: (await viem.getWalletClients())[4] },
      });
      await assert.rejects(asAttacker.write.redeem([tokenId]), /NotGate/);
    });
  });

  // ─── the factory ───────────────────────────────────────────────────────────

  describe('EventFactory', () => {
    it('deploys a ticket contract per event and records the policy hash', async () => {
      const factory = await viem.deployContract('EventFactory', [
        registry.address,
        deployer,
        deployer,
        controller.address,
      ]);

      const eventId = '0x' + '5e'.repeat(32);
      await factory.write.createEvent([eventId, 'Sunburn', 'SBW', POLICY_HASH, 1000, [GA, VIP]]);

      const deployed = await factory.read.ticketContractOf([eventId]);
      assert.notEqual(deployed, ZERO);
      assert.equal(await factory.read.eventCount(), 1n);

      const nft = await viem.getContractAt('TicketNFT', deployed);
      assert.equal(await nft.read.policyHash(), POLICY_HASH);
      assert.equal(await nft.read.tierCount(), 2);
    });

    it('refuses a duplicate event id', async () => {
      const factory = await viem.deployContract('EventFactory', [
        registry.address,
        deployer,
        deployer,
        controller.address,
      ]);
      const eventId = '0x' + '5e'.repeat(32);
      await factory.write.createEvent([eventId, 'A', 'A', POLICY_HASH, 100, [GA]]);
      await assert.rejects(
        factory.write.createEvent([eventId, 'B', 'B', POLICY_HASH, 100, [GA]]),
        /EventExists/,
      );
    });

    it('refuses a caller who is not an approved organizer', async () => {
      const factory = await viem.deployContract('EventFactory', [
        registry.address,
        deployer,
        deployer,
        controller.address,
      ]);
      const asAttacker = await viem.getContractAt('EventFactory', factory.address, {
        client: { wallet: (await viem.getWalletClients())[4] },
      });
      await assert.rejects(
        asAttacker.write.createEvent(['0x' + 'aa'.repeat(32), 'X', 'X', POLICY_HASH, 100, [GA]]),
        /NotOrganizer/,
      );
    });
  });
});
