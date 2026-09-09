import { describe, expect, it } from 'vitest';
import { DAY, applyTicketEvent, canApply, epochMs, isValidForEntry, minor, validateEvent, validateResalePolicy } from '../src/index.js';
import type { TicketState } from '../src/index.js';
import { BOB, T0, boundPolicy, cappedPolicy, festival, gaTier, ticket } from './fixtures.js';

describe('ticket state machine', () => {
  it('walks the happy path: held → issued → redeemed', () => {
    const held = ticket({ state: 'held' });
    const issued = applyTicketEvent(held, { kind: 'pay' });
    expect(issued).toMatchObject({ ok: true });
    if (!issued.ok) return;
    expect(issued.value.state).toBe('issued');

    const redeemed = applyTicketEvent(issued.value, { kind: 'redeem', at: epochMs(T0 + 30 * DAY) });
    expect(redeemed).toMatchObject({ ok: true });
    if (redeemed.ok) expect(redeemed.value.state).toBe('redeemed');
  });

  it('returns a ticket to issued after a sale, with a new owner and a reset cooldown', () => {
    const listed = ticket({ state: 'listed' });
    const at = epochMs(T0 + 5 * DAY);
    const sold = applyTicketEvent(listed, { kind: 'sell', toIdentity: BOB, at });

    expect(sold).toMatchObject({ ok: true });
    if (!sold.ok) return;
    expect(sold.value.state).toBe('issued');
    expect(sold.value.ownerIdentityId).toBe(BOB);
    expect(sold.value.acquiredAt).toBe(at); // cooldown restarts for the new owner
    expect(sold.value.resaleCount).toBe(1);
  });

  it('refuses every illegal transition rather than silently ignoring it', () => {
    expect(applyTicketEvent(ticket({ state: 'redeemed' }), { kind: 'list' })).toMatchObject({
      ok: false,
      code: 'ILLEGAL_TRANSITION',
    });
    expect(applyTicketEvent(ticket({ state: 'revoked' }), { kind: 'pay' })).toMatchObject({ ok: false });
    expect(applyTicketEvent(ticket({ state: 'refunded' }), { kind: 'redeem', at: T0 })).toMatchObject({
      ok: false,
    });
    expect(applyTicketEvent(ticket({ state: 'held' }), { kind: 'list' })).toMatchObject({ ok: false });
  });

  it('lets a ticket be revoked from any live state, because resale and fraud both need it', () => {
    for (const state of ['issued', 'listed', 'redeemed'] as const) {
      expect(canApply(state, 'revoke')).toBe(true);
    }
  });

  it('treats refunded and revoked as terminal', () => {
    for (const state of ['refunded', 'revoked'] as const) {
      for (const kind of ['pay', 'list', 'sell', 'redeem', 'refund', 'revoke'] as const) {
        expect(canApply(state, kind)).toBe(false);
      }
    }
  });

  it('counts a listed ticket as valid for entry — it is still yours until it sells', () => {
    const valid: TicketState[] = ['issued', 'listed'];
    const invalid: TicketState[] = ['held', 'redeemed', 'refunded', 'revoked'];
    for (const s of valid) expect(isValidForEntry(s)).toBe(true);
    for (const s of invalid) expect(isValidForEntry(s)).toBe(false);
  });

  it('does not mutate the ticket it was given', () => {
    const original = ticket({ state: 'listed' });
    applyTicketEvent(original, { kind: 'sell', toIdentity: BOB, at: T0 });
    expect(original.state).toBe('listed');
    expect(original.resaleCount).toBe(0);
  });
});

describe('policy validation', () => {
  it('accepts the fixtures', () => {
    expect(() => validateEvent(festival)).not.toThrow();
    expect(() => validateResalePolicy(cappedPolicy)).not.toThrow();
    expect(() => validateResalePolicy(boundPolicy)).not.toThrow();
  });

  it('refuses splits that allocate more than the sale price', () => {
    expect(() =>
      validateResalePolicy({
        ...cappedPolicy,
        splits: { organizerBps: 8_000, platformBps: 3_000, rightsHolderBps: 0 },
      }),
    ).toThrow(/more than 100%/);
  });

  it('refuses a ceiling below face value, and says to use bound mode instead', () => {
    expect(() => validateResalePolicy({ ...cappedPolicy, maxPriceBps: 9_000 })).toThrow(/bound/);
  });

  it('refuses a window that closes before it opens', () => {
    expect(() =>
      validateResalePolicy({ ...cappedPolicy, closesAt: epochMs(cappedPolicy.opensAt - 1) }),
    ).toThrow(/closes at/);
  });

  it('refuses to oversell capacity — an invariant, not a warning', () => {
    expect(() =>
      validateEvent({
        ...festival,
        capacity: 100,
        tiers: [{ ...gaTier, allocation: 500 }],
      }),
    ).toThrow(/overselling/);
  });

  it('refuses duplicate tier ids', () => {
    // Small allocations, so the capacity check does not fire first and mask this.
    const small = { ...gaTier, allocation: 10 };
    expect(() => validateEvent({ ...festival, tiers: [small, small] })).toThrow(/duplicate tier/);
  });

  it('refuses an event with no tiers', () => {
    expect(() => validateEvent({ ...festival, tiers: [] })).toThrow(/no tiers/);
  });

  it('leaves a bound policy alone even though its window values are inert zeroes', () => {
    // NO_RESALE-shaped policies would fail every window check, so bound mode
    // short-circuits validation. Regression guard for that branch.
    expect(() =>
      validateResalePolicy({
        ...boundPolicy,
        opensAt: epochMs(0),
        closesAt: epochMs(0),
        maxPriceBps: 0,
      }),
    ).not.toThrow();
  });
});

describe('money guards', () => {
  it('refuses fractional and negative amounts at the boundary', () => {
    expect(() => minor(1.5)).toThrow();
    expect(() => minor(-1)).toThrow();
  });
});
