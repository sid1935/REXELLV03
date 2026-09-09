import { describe, expect, it } from 'vitest';
import {
  DAY,
  HOUR,
  MINUTE,
  applyDeltas,
  decideEntry,
  emptyManifest,
  epochMs,
  findDoubleEntries,
  identityId,
  laneId,
  manifestStaleness,
  templateRef,
  ticketId,
} from '../src/index.js';
import type { Delta, EntryAttestation, EntryInput, Manifest } from '../src/index.js';
import { ALICE, BOB, DOORS, EVENT_ID, LANE_A, T0, manifestEntry } from './fixtures.js';

const EXPIRY = epochMs(DOORS + 12 * HOUR);
const AT_DOORS = epochMs(DOORS + 10 * MINUTE);
const TKT = ticketId('tkt_0001');

function manifestWith(...entries: ReturnType<typeof manifestEntry>[]): Manifest {
  return {
    ...emptyManifest(EVENT_ID, epochMs(DOORS - 2 * HOUR), EXPIRY),
    entries: new Map(entries.map((e) => [e.ticketId, e])),
  };
}

function input(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    manifest: manifestWith(manifestEntry()),
    match: { matched: true, identityId: ALICE, score: 0.94 },
    now: AT_DOORS,
    lane: LANE_A,
    gateGroup: 'north',
    matchThreshold: 0.9,
    reviewThreshold: 0.75,
    admitted: new Set(),
    allowReentry: false,
    ...overrides,
  };
}

describe('decideEntry', () => {
  it('admits the person whose face matches their own ticket', () => {
    expect(decideEntry(input())).toMatchObject({ outcome: 'admit', code: 'MATCHED', ticketId: TKT });
  });

  it('sends an uncertain match to the resolution desk rather than guessing', () => {
    // Between review and match thresholds: plausibly them, not certainly them.
    const d = decideEntry(input({ match: { matched: true, identityId: ALICE, score: 0.82 } }));
    expect(d).toMatchObject({ outcome: 'fallback', code: 'LOW_CONFIDENCE' });
  });

  it('treats a weak match as no match at all', () => {
    const d = decideEntry(input({ match: { matched: true, identityId: ALICE, score: 0.4 } }));
    expect(d).toMatchObject({ outcome: 'fallback', code: 'NO_MATCH' });
  });

  it('never denies on a failed match — a false reject must not send a fan home', () => {
    const d = decideEntry(input({ match: { matched: false, score: 0 } }));
    expect(d.outcome).toBe('fallback');
    expect(d.outcome).not.toBe('deny');
  });

  it('denies a matched person with no ticket', () => {
    const d = decideEntry(input({ match: { matched: true, identityId: BOB, score: 0.98 } }));
    expect(d).toMatchObject({ outcome: 'deny', code: 'NOT_IN_MANIFEST' });
  });

  it('denies the seller after their ticket is resold — the whole point of the binding', () => {
    const d = decideEntry(input({ manifest: manifestWith(manifestEntry({ revoked: true })) }));
    expect(d).toMatchObject({ outcome: 'deny', code: 'CREDENTIAL_REVOKED' });
  });

  it('denies a valid ticket at the wrong entrance, and says where to go', () => {
    const d = decideEntry(input({ manifest: manifestWith(manifestEntry({ gates: ['south'] })) }));
    expect(d).toMatchObject({ outcome: 'deny', code: 'WRONG_GATE' });
    expect(d.operatorMessage).toContain('south');
  });

  it('honours the admission window at both edges', () => {
    const entry = manifestEntry();
    const early = decideEntry(input({ now: epochMs(entry.admitFrom - 1) }));
    const first = decideEntry(input({ now: entry.admitFrom }));
    const last = decideEntry(input({ now: epochMs(entry.admitUntil - 1) }));
    const late = decideEntry(input({ now: entry.admitUntil }));

    expect(early).toMatchObject({ outcome: 'deny', code: 'TOO_EARLY' });
    expect(first.outcome).toBe('admit');
    expect(last.outcome).toBe('admit');
    expect(late).toMatchObject({ outcome: 'deny', code: 'TOO_LATE' });
  });

  it('blocks a second entry when the event does not allow pass-outs', () => {
    const d = decideEntry(input({ admitted: new Set([TKT]) }));
    expect(d).toMatchObject({ outcome: 'deny', code: 'ALREADY_ADMITTED' });
  });

  it('welcomes a re-entry when the event does allow pass-outs', () => {
    const d = decideEntry(input({ admitted: new Set([TKT]), allowReentry: true }));
    expect(d).toMatchObject({ outcome: 'admit', code: 'REENTRY' });
  });

  it('falls back rather than failing open when the manifest has expired', () => {
    const d = decideEntry(input({ now: epochMs(EXPIRY + 1) }));
    expect(d).toMatchObject({ outcome: 'fallback', code: 'MANIFEST_EXPIRED' });
  });
});

describe('applyDeltas', () => {
  const base = manifestWith(manifestEntry());

  const revoke = (seq: number): Delta => ({ seq, kind: 'revoke', ticketId: TKT, reason: 'resold' });
  const rebind = (seq: number): Delta => ({
    seq,
    kind: 'rebind',
    ticketId: TKT,
    identityId: BOB,
    templateRef: templateRef('tpl_bob_v1'),
  });

  it('applies a contiguous run in order', () => {
    const r = applyDeltas(base, [rebind(1), revoke(2)]);
    expect(r.applied).toBe(2);
    expect(r.manifest.sequence).toBe(2);
    expect(r.gapDetected).toBe(false);
    expect(r.manifest.entries.get(TKT)).toMatchObject({ identityId: BOB, revoked: true });
  });

  it('sorts an out-of-order batch before applying it', () => {
    const r = applyDeltas(base, [revoke(2), rebind(1)]);
    expect(r.applied).toBe(2);
    expect(r.manifest.sequence).toBe(2);
  });

  it('is idempotent — a redelivered batch changes nothing', () => {
    const once = applyDeltas(base, [rebind(1), revoke(2)]);
    const twice = applyDeltas(once.manifest, [rebind(1), revoke(2)]);
    expect(twice.applied).toBe(0);
    expect(twice.manifest.sequence).toBe(2);
    expect(twice.manifest.entries.get(TKT)).toEqual(once.manifest.entries.get(TKT));
  });

  it('stops at a gap instead of guessing, and reports it', () => {
    // Delta 2 is missing. Applying 3 could admit somebody 2 had just revoked.
    const r = applyDeltas(base, [rebind(1), revoke(3)]);
    expect(r.applied).toBe(1);
    expect(r.manifest.sequence).toBe(1);
    expect(r.gapDetected).toBe(true);
    expect(r.deferred).toHaveLength(1);
    expect(r.manifest.entries.get(TKT)?.revoked).toBe(false);
  });

  it('does not apply anything after a gap, even if it arrives in the same batch', () => {
    const r = applyDeltas(base, [revoke(3), rebind(4)]);
    expect(r.applied).toBe(0);
    expect(r.deferred).toHaveLength(2);
  });

  it('ignores deltas for tickets it has never heard of', () => {
    const stray: Delta = { seq: 1, kind: 'revoke', ticketId: ticketId('tkt_unknown'), reason: 'x' };
    const r = applyDeltas(base, [stray]);
    expect(r.applied).toBe(1);
    expect(r.manifest.entries.size).toBe(1);
  });

  it('adds a late sale', () => {
    const late = manifestEntry({ ticketId: ticketId('tkt_late'), identityId: identityId('id_dan') });
    const r = applyDeltas(base, [{ seq: 1, kind: 'add', entry: late }]);
    expect(r.manifest.entries.size).toBe(2);
  });
});

describe('manifestStaleness', () => {
  it('reports how far behind a lane is and warns', () => {
    const m = applyDeltas(manifestWith(manifestEntry()), [
      { seq: 1, kind: 'revoke', ticketId: TKT, reason: 'resold' },
    ]).manifest;

    const s = manifestStaleness(m, 5, AT_DOORS);
    expect(s.behindBy).toBe(4);
    expect(s.warn).toBe(true);
    expect(s.expired).toBe(false);
  });

  it('does not warn when the lane is current', () => {
    const m = manifestWith(manifestEntry());
    expect(manifestStaleness(m, 0, AT_DOORS).warn).toBe(false);
  });

  it('flags an expired manifest', () => {
    const m = manifestWith(manifestEntry());
    expect(manifestStaleness(m, 0, epochMs(EXPIRY + 1)).expired).toBe(true);
  });
});

describe('findDoubleEntries', () => {
  const attest = (over: Partial<EntryAttestation>): EntryAttestation => ({
    ticketId: TKT,
    identityId: ALICE,
    lane: LANE_A,
    decidedAt: AT_DOORS,
    outcome: 'admit',
    code: 'MATCHED',
    matchScore: 0.95,
    manifestSequence: 4,
    offline: false,
    ...over,
  });

  it('finds nothing when every ticket entered once', () => {
    expect(findDoubleEntries([attest({}), attest({ ticketId: ticketId('tkt_0002') })])).toHaveLength(0);
  });

  it('catches the same ticket admitted at two lanes during a partition', () => {
    const found = findDoubleEntries([
      attest({ lane: laneId('lane_a'), offline: true }),
      attest({ lane: laneId('lane_b'), offline: true, decidedAt: epochMs(AT_DOORS + 40 * 1000) }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.attestations).toHaveLength(2);
    // Ordered by time, so an investigator can see which lane was first.
    expect(found[0]?.attestations[0]?.lane).toBe('lane_a');
  });

  it('does not count a legitimate re-entry as a double entry', () => {
    const found = findDoubleEntries([attest({}), attest({ code: 'REENTRY' })]);
    expect(found).toHaveLength(0);
  });

  it('ignores denials and fallbacks', () => {
    const found = findDoubleEntries([
      attest({ outcome: 'deny', code: 'CREDENTIAL_REVOKED' }),
      attest({ outcome: 'fallback', code: 'NO_MATCH' }),
    ]);
    expect(found).toHaveLength(0);
  });
});

describe('a resale revokes the seller and admits the buyer', () => {
  it('end to end, through the manifest', () => {
    // Alice holds tkt_0001 and would be admitted.
    const before = manifestWith(manifestEntry());
    expect(decideEntry(input({ manifest: before })).outcome).toBe('admit');

    // She resells to Bob. Two deltas: rebind the credential, and the gate learns.
    const after = applyDeltas(before, [
      { seq: 1, kind: 'rebind', ticketId: TKT, identityId: BOB, templateRef: templateRef('tpl_bob_v1') },
    ]).manifest;

    // Alice's face no longer opens the gate.
    const alice = decideEntry(input({ manifest: after, match: { matched: true, identityId: ALICE, score: 0.97 } }));
    expect(alice).toMatchObject({ outcome: 'deny', code: 'NOT_IN_MANIFEST' });

    // Bob's does.
    const bob = decideEntry(input({ manifest: after, match: { matched: true, identityId: BOB, score: 0.97 } }));
    expect(bob).toMatchObject({ outcome: 'admit', code: 'MATCHED', ticketId: TKT });
  });
});

describe('a scanner that has been offline still decides correctly', () => {
  it('uses only the manifest it holds, with no network anywhere in the call', () => {
    // decideEntry takes no client, no fetch, no clock. This test is really an
    // assertion about the signature: if it ever needs I/O, this stops compiling.
    const offlineManifest = manifestWith(manifestEntry());
    const d = decideEntry(input({ manifest: offlineManifest, now: epochMs(DOORS + 1 * HOUR) }));
    expect(d.outcome).toBe('admit');
  });

  it('still honours a revocation it managed to sync before going dark', () => {
    const synced = applyDeltas(manifestWith(manifestEntry()), [
      { seq: 1, kind: 'revoke', ticketId: TKT, reason: 'resold' },
    ]).manifest;
    expect(decideEntry(input({ manifest: synced }))).toMatchObject({
      outcome: 'deny',
      code: 'CREDENTIAL_REVOKED',
    });
  });
});

describe('time helpers', () => {
  it('DAY and HOUR are what the fixtures assume', () => {
    expect(DAY).toBe(86_400_000);
    expect(T0 + 1 * DAY).toBeGreaterThan(T0);
  });
});
