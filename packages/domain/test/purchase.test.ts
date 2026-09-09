import { describe, expect, it } from 'vitest';
import { HOUR, epochMs, evaluatePurchase } from '../src/index.js';
import type { TierAvailability } from '../src/index.js';
import { T0, buyer, festival, gaTier } from './fixtures.js';

const NOW = epochMs(T0 + 1 * HOUR);
const plenty: TierAvailability = { sold: 0, held: 0 };
const req = (quantity = 1) => ({ tier: gaTier, quantity, now: NOW });

describe('evaluatePurchase', () => {
  it('allows an ordinary purchase', () => {
    expect(evaluatePurchase(festival, req(2), buyer(), plenty)).toMatchObject({ ok: true });
  });

  it('blocks a request the risk layer rejected, before anything else is checked', () => {
    // Even a perfectly eligible buyer is stopped, and the message gives a bot
    // nothing to learn from.
    const v = evaluatePurchase(festival, req(), buyer({ riskVerdict: 'block' }), plenty);
    expect(v).toMatchObject({ ok: false, code: 'RISK_BLOCKED' });
    if (!v.ok) expect(v.message).not.toContain('bot');
  });

  it('lets a challenged request through — challenge is friction, not a block', () => {
    expect(evaluatePurchase(festival, req(), buyer({ riskVerdict: 'challenge' }), plenty)).toMatchObject({
      ok: true,
    });
  });

  it('requires enrolment, because an unbound ticket opens no gate', () => {
    expect(evaluatePurchase(festival, req(), buyer({ enrolled: false }), plenty)).toMatchObject({
      ok: false,
      code: 'NOT_ENROLLED',
    });
  });

  it('holds the per-identity limit and says how many are left', () => {
    const v = evaluatePurchase(festival, req(2), buyer({ ticketsHeldForEvent: 3 }), plenty);
    expect(v).toMatchObject({ ok: false, code: 'PURCHASE_LIMIT_REACHED' });
    if (!v.ok) {
      expect(v.detail).toMatchObject({ remaining: 1 });
      expect(v.message).toContain('1 more ticket');
    }
  });

  it('allows a purchase that lands exactly on the limit', () => {
    expect(evaluatePurchase(festival, req(1), buyer({ ticketsHeldForEvent: 3 }), plenty)).toMatchObject({
      ok: true,
    });
  });

  it('respects the sales window at both edges', () => {
    const beforeOpen = { tier: gaTier, quantity: 1, now: epochMs(festival.salesOpenAt - 1) };
    const atOpen = { tier: gaTier, quantity: 1, now: festival.salesOpenAt };
    const atClose = { tier: gaTier, quantity: 1, now: festival.salesCloseAt };

    expect(evaluatePurchase(festival, beforeOpen, buyer(), plenty)).toMatchObject({ code: 'SALE_NOT_OPEN' });
    expect(evaluatePurchase(festival, atOpen, buyer(), plenty)).toMatchObject({ ok: true });
    expect(evaluatePurchase(festival, atClose, buyer(), plenty)).toMatchObject({ code: 'SALE_CLOSED' });
  });

  it('counts holds as well as sales against the allocation', () => {
    // Inventory another shopper is holding is not available, even though it is unsold.
    const nearlyGone: TierAvailability = { sold: gaTier.allocation - 3, held: 2 };
    expect(evaluatePurchase(festival, req(2), buyer(), nearlyGone)).toMatchObject({
      ok: false,
      code: 'SOLD_OUT',
    });
    expect(evaluatePurchase(festival, req(1), buyer(), nearlyGone)).toMatchObject({ ok: true });
  });

  it('enforces an age gate when one is set', () => {
    const eighteenPlus = { ...festival, minimumAge: 18 };
    expect(evaluatePurchase(eighteenPlus, req(), buyer({ ageYears: 17 }), plenty)).toMatchObject({
      code: 'UNDER_MINIMUM_AGE',
    });
    expect(evaluatePurchase(eighteenPlus, req(), buyer({ ageYears: 18 }), plenty)).toMatchObject({ ok: true });
    // Unknown age fails closed, not open.
    expect(evaluatePurchase(eighteenPlus, req(), buyer(), plenty)).toMatchObject({ code: 'UNDER_MINIMUM_AGE' });
  });

  it('rejects nonsense quantities', () => {
    for (const q of [0, -1, 1.5]) {
      expect(evaluatePurchase(festival, req(q), buyer(), plenty).ok).toBe(false);
    }
  });
});
