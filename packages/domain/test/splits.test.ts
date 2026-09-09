import { describe, expect, it } from 'vitest';
import { PolicyError, computeSplits, minor, splitsBalance, sum } from '../src/index.js';
import type { SplitTable } from '../src/index.js';

const standard: SplitTable = { organizerBps: 700, platformBps: 300, rightsHolderBps: 200 };

describe('computeSplits', () => {
  it('splits the worked example from the business plan exactly', () => {
    // ₹2,420.00 resale of a ₹2,200.00 ticket at the 110% ceiling.
    const result = computeSplits(minor(242_000), standard);

    expect(result.organizer).toBe(16_940); // 7%   = ₹169.40
    expect(result.platform).toBe(7_260); //   3%   = ₹72.60
    expect(result.rightsHolder).toBe(4_840); // 2%  = ₹48.40
    expect(result.seller).toBe(212_960); //   88%  = ₹2,129.60
    expect(result.total).toBe(242_000);
  });

  it('always balances exactly, for every price in a wide sweep', () => {
    // The invariant that matters. If this ever fails, an organizer is being
    // shortchanged a paisa at a time, several thousand times a night.
    for (let price = 0; price <= 5_000; price += 1) {
      const r = computeSplits(minor(price), standard);
      expect(splitsBalance(r)).toBe(true);
      expect(sum([r.organizer, r.platform, r.rightsHolder, r.seller])).toBe(price);
    }
  });

  it('balances for awkward bps values that do not divide evenly', () => {
    const awkward: SplitTable = { organizerBps: 333, platformBps: 333, rightsHolderBps: 334 };
    for (const price of [1, 7, 99, 101, 999, 1_000_001]) {
      const r = computeSplits(minor(price), awkward);
      expect(splitsBalance(r)).toBe(true);
    }
  });

  it('gives rounding remainder to the seller, never to the platform', () => {
    // 1 paisa at 3% floors to 0 for every fixed party; the seller keeps the lot.
    const r = computeSplits(minor(1), standard);
    expect(r.organizer).toBe(0);
    expect(r.platform).toBe(0);
    expect(r.rightsHolder).toBe(0);
    expect(r.seller).toBe(1);
  });

  it('handles a zero-commission event', () => {
    const free: SplitTable = { organizerBps: 0, platformBps: 0, rightsHolderBps: 0 };
    const r = computeSplits(minor(242_000), free);
    expect(r.seller).toBe(242_000);
    expect(splitsBalance(r)).toBe(true);
  });

  it('handles a full 100% allocation leaving the seller nothing', () => {
    const all: SplitTable = { organizerBps: 5_000, platformBps: 3_000, rightsHolderBps: 2_000 };
    const r = computeSplits(minor(1_000), all);
    expect(r.seller).toBe(0);
    expect(splitsBalance(r)).toBe(true);
  });

  it('refuses to allocate more than 100%', () => {
    const overdrawn: SplitTable = { organizerBps: 7_000, platformBps: 4_000, rightsHolderBps: 0 };
    expect(() => computeSplits(minor(1_000), overdrawn)).toThrow(PolicyError);
  });

  it('handles a zero-value sale', () => {
    const r = computeSplits(minor(0), standard);
    expect(r).toMatchObject({ organizer: 0, platform: 0, rightsHolder: 0, seller: 0, total: 0 });
  });
});
