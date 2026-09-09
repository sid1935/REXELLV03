import { describe, expect, it } from 'vitest';
import {
  DAY,
  HOUR,
  epochMs,
  evaluateListing,
  evaluateListingPurchase,
  identityId,
  minor,
  resaleCeiling,
  resaleFloor,
} from '../src/index.js';
import { ALICE, BOB, T0, buyer, cappedPolicy, gaTier, listing, ticket, vipTier } from './fixtures.js';

const seller = (activeListings = 0) => ({ identityId: ALICE, activeListings });
const AFTER_COOLDOWN = epochMs(T0 + 2 * DAY);

describe('evaluateListing', () => {
  it('accepts a listing at exactly the ceiling', () => {
    const ceiling = resaleCeiling(gaTier);
    expect(ceiling).toBe(242_000); // 110% of ₹2,200.00

    const v = evaluateListing(ticket(), gaTier, ceiling, seller(), AFTER_COOLDOWN);
    expect(v.ok).toBe(true);
  });

  it('rejects one paisa above the ceiling', () => {
    const v = evaluateListing(ticket(), gaTier, minor(242_001), seller(), AFTER_COOLDOWN);
    expect(v).toMatchObject({ ok: false, code: 'PRICE_ABOVE_CEILING' });
    if (!v.ok) expect(v.message).toContain('₹2,420.00');
  });

  it('accepts exactly the floor and rejects one paisa below it', () => {
    const floor = resaleFloor(gaTier);
    expect(floor).toBe(110_000);
    expect(evaluateListing(ticket(), gaTier, floor, seller(), AFTER_COOLDOWN).ok).toBe(true);
    expect(evaluateListing(ticket(), gaTier, minor(109_999), seller(), AFTER_COOLDOWN)).toMatchObject({
      ok: false,
      code: 'PRICE_BELOW_FLOOR',
    });
  });

  it('refuses outright when the organizer bound the tier', () => {
    const v = evaluateListing(
      ticket({ tierId: vipTier.id }),
      vipTier,
      minor(850_000),
      seller(),
      AFTER_COOLDOWN,
    );
    expect(v).toMatchObject({ ok: false, code: 'RESALE_DISABLED' });
    // A bound ticket must never be listable at any price, even face value.
    if (!v.ok) expect(v.message).toContain('refund');
  });

  it('holds the line on the cooldown, then lets go', () => {
    const justBought = ticket({ acquiredAt: epochMs(T0 + 1 * DAY) });
    const oneMsEarly = epochMs(T0 + 1 * DAY + cappedPolicy.cooldownMs - 1);
    const bangOn = epochMs(T0 + 1 * DAY + cappedPolicy.cooldownMs);

    expect(evaluateListing(justBought, gaTier, minor(220_000), seller(), oneMsEarly)).toMatchObject({
      ok: false,
      code: 'COOLDOWN_ACTIVE',
    });
    expect(evaluateListing(justBought, gaTier, minor(220_000), seller(), bangOn).ok).toBe(true);
  });

  it('respects the resale window at both edges', () => {
    const before = epochMs(cappedPolicy.opensAt - 1);
    const atOpen = cappedPolicy.opensAt;
    const atClose = cappedPolicy.closesAt;

    // acquiredAt far enough back that cooldown is not the reason for any rejection
    const t = ticket({ acquiredAt: epochMs(T0 - 30 * DAY) });

    expect(evaluateListing(t, gaTier, minor(220_000), seller(), before)).toMatchObject({
      ok: false,
      code: 'RESALE_WINDOW_NOT_OPEN',
    });
    expect(evaluateListing(t, gaTier, minor(220_000), seller(), atOpen).ok).toBe(true);
    expect(evaluateListing(t, gaTier, minor(220_000), seller(), atClose)).toMatchObject({
      ok: false,
      code: 'RESALE_WINDOW_CLOSED',
    });
  });

  it('stops a ticket being flipped more times than the organizer allowed', () => {
    const flipped = ticket({ resaleCount: 2, acquiredAt: epochMs(T0 - 30 * DAY) });
    expect(evaluateListing(flipped, gaTier, minor(220_000), seller(), AFTER_COOLDOWN)).toMatchObject({
      ok: false,
      code: 'RESALE_LIMIT_REACHED',
    });
  });

  it('caps how many listings one identity can run at once', () => {
    const t = ticket({ acquiredAt: epochMs(T0 - 30 * DAY) });
    expect(evaluateListing(t, gaTier, minor(220_000), seller(2), AFTER_COOLDOWN)).toMatchObject({
      ok: false,
      code: 'LISTING_LIMIT_REACHED',
    });
  });

  it('will not list a ticket that is already listed, redeemed or revoked', () => {
    for (const state of ['listed', 'redeemed', 'revoked', 'refunded', 'held'] as const) {
      const v = evaluateListing(
        ticket({ state, acquiredAt: epochMs(T0 - 30 * DAY) }),
        gaTier,
        minor(220_000),
        seller(),
        AFTER_COOLDOWN,
      );
      expect(v).toMatchObject({ ok: false, code: 'TICKET_NOT_LISTABLE' });
    }
  });

  it('will not let somebody list a ticket they do not own', () => {
    const v = evaluateListing(
      ticket({ ownerIdentityId: BOB, acquiredAt: epochMs(T0 - 30 * DAY) }),
      gaTier,
      minor(220_000),
      seller(),
      AFTER_COOLDOWN,
    );
    expect(v).toMatchObject({ ok: false, code: 'TICKET_NOT_LISTABLE' });
  });
});

describe('evaluateListingPurchase', () => {
  const NOW = epochMs(T0 + 3 * DAY);
  const price = minor(242_000);

  it('lets a clean buyer take an active listing', () => {
    const v = evaluateListingPurchase(listing(), gaTier, buyer({ identityId: BOB }), price, 4, NOW);
    expect(v).toMatchObject({ ok: true });
  });

  it('refuses to let a seller buy their own listing', () => {
    const v = evaluateListingPurchase(listing(), gaTier, buyer({ identityId: ALICE }), price, 4, NOW);
    expect(v).toMatchObject({ ok: false, code: 'CANNOT_BUY_OWN_LISTING' });
  });

  it('refuses when the price moved under the buyer', () => {
    const v = evaluateListingPurchase(
      listing({ price: minor(242_000) }),
      gaTier,
      buyer({ identityId: BOB }),
      minor(230_000),
      4,
      NOW,
    );
    expect(v).toMatchObject({ ok: false, code: 'PRICE_CHANGED' });
  });

  it('refuses a listing that has already gone', () => {
    for (const state of ['sold', 'cancelled', 'expired'] as const) {
      expect(
        evaluateListingPurchase(listing({ state }), gaTier, buyer({ identityId: BOB }), price, 4, NOW),
      ).toMatchObject({ ok: false, code: 'LISTING_NOT_ACTIVE' });
    }
  });

  it('counts a resale against the per-event limit — the obvious bypass', () => {
    // Someone at their 4-ticket limit must not be able to top up on the secondary
    // market. This is the check a farm would probe for first.
    const atLimit = buyer({ identityId: BOB, ticketsHeldForEvent: 4 });
    expect(evaluateListingPurchase(listing(), gaTier, atLimit, price, 4, NOW)).toMatchObject({
      ok: false,
      code: 'PURCHASE_LIMIT_REACHED',
    });
  });

  it('requires the buyer to be enrolled — an unbound ticket opens no gate', () => {
    const v = evaluateListingPurchase(
      listing(),
      gaTier,
      buyer({ identityId: identityId('id_carol'), enrolled: false }),
      price,
      4,
      NOW,
    );
    expect(v).toMatchObject({ ok: false, code: 'NOT_ENROLLED' });
  });

  it('refuses once the resale window has shut', () => {
    const afterClose = epochMs(cappedPolicy.closesAt + 1 * HOUR);
    expect(
      evaluateListingPurchase(listing(), gaTier, buyer({ identityId: BOB }), price, 4, afterClose),
    ).toMatchObject({ ok: false, code: 'RESALE_WINDOW_CLOSED' });
  });
});
