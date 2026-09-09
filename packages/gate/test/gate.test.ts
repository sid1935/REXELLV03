import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GateEngine,
  ManifestError,
  deriveManifestKey,
  generateDeviceKey,
  openManifest,
  sealManifest,
  signAttestation,
  verifyAttestation,
} from '../src/index.js';
import { DOORS, EVENT, EXPIRY, MASTER, SCANNER, capture, engine, entry, face, manifest, roundTrip } from './helpers.js';

describe('the sealed manifest', () => {
  it('round-trips templates through the wire format', () => {
    const original = manifest(5);
    const reopened = roundTrip(original);

    expect(reopened.entries).toHaveLength(5);
    expect(reopened.entries[0]?.ticketId).toBe('tkt_0000');
    // Templates survive the base64 float encoding intact.
    const a = original.entries[0]!.template;
    const b = reopened.entries[0]!.template;
    for (let i = 0; i < a.length; i += 1) expect(b[i]).toBeCloseTo(a[i]!, 6);
  });

  it('is inert without the key, which is released separately', () => {
    const m = manifest(3);
    const sealed = sealManifest(m, deriveManifestKey(MASTER, SCANNER, EVENT, EXPIRY));

    // A manifest can be pushed to a device days early over any channel. Until
    // doors-open releases the key, it is a blob.
    const wrongKey = deriveManifestKey(randomBytes(32), SCANNER, EVENT, EXPIRY);
    expect(() => openManifest(sealed, wrongKey, DOORS)).toThrow(ManifestError);
    expect(JSON.stringify(sealed)).not.toMatch(/tkt_|idn_/);
  });

  it('cannot be opened by a different device', () => {
    const m = manifest(3);
    const key = deriveManifestKey(MASTER, SCANNER, EVENT, EXPIRY);
    const sealed = sealManifest(m, key);
    expect(() => openManifest(sealed, key, DOORS, 'scn_someone_else')).toThrow(/not issued to this device/);
  });

  it('cannot have its life extended by editing the envelope', () => {
    // The expiry is authenticated data AND part of the key derivation, so a
    // longer TTL is a different key over different AAD. Both fail.
    const m = manifest(3);
    const key = deriveManifestKey(MASTER, SCANNER, EVENT, EXPIRY);
    const sealed = sealManifest(m, key);
    const extended = { ...sealed, expiresAt: EXPIRY + 86_400_000 };
    expect(() => openManifest(extended, key, DOORS)).toThrow(ManifestError);
  });

  it('refuses to open after its TTL, even with the right key', () => {
    const m = manifest(3);
    const key = deriveManifestKey(MASTER, SCANNER, EVENT, EXPIRY);
    const sealed = sealManifest(m, key);

    expect(() => openManifest(sealed, key, EXPIRY - 1)).not.toThrow();
    const err = (() => {
      try {
        openManifest(sealed, key, EXPIRY);
      } catch (e) {
        return e as ManifestError;
      }
      return undefined;
    })();
    expect(err?.code).toBe('EXPIRED');
  });

  it('detects tampering with the ciphertext', () => {
    const key = deriveManifestKey(MASTER, SCANNER, EVENT, EXPIRY);
    const sealed = sealManifest(manifest(3), key);
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    expect(() => openManifest({ ...sealed, ciphertext: bytes.toString('base64') }, key, DOORS)).toThrow(ManifestError);
  });

  it('derives a different key per scanner, so one leak does not open every lane', () => {
    const a = deriveManifestKey(MASTER, 'scn_a', EVENT, EXPIRY);
    const b = deriveManifestKey(MASTER, 'scn_b', EVENT, EXPIRY);
    expect(a.equals(b)).toBe(false);
  });
});

describe('signed attestations', () => {
  it('verifies under the device public key', () => {
    const keys = generateDeviceKey();
    const a = signAttestation(
      {
        ticketId: 'tkt_1',
        identityId: 'idn_1',
        eventId: EVENT,
        lane: 'lane_a',
        decidedAt: DOORS,
        outcome: 'admit',
        code: 'MATCHED',
        matchScore: 0.96,
        manifestSequence: 3,
        offline: true,
      },
      SCANNER,
      keys.privateKeyPem,
    );
    expect(verifyAttestation(a, keys.publicKeyPem)).toBe(true);
  });

  it('fails verification under a different device key', () => {
    const mine = generateDeviceKey();
    const theirs = generateDeviceKey();
    const a = signAttestation(
      {
        ticketId: 'tkt_1',
        identityId: 'idn_1',
        eventId: EVENT,
        lane: 'lane_a',
        decidedAt: DOORS,
        outcome: 'admit',
        code: 'MATCHED',
        matchScore: 0.96,
        manifestSequence: 3,
        offline: true,
      },
      SCANNER,
      mine.privateKeyPem,
    );
    expect(verifyAttestation(a, theirs.publicKeyPem)).toBe(false);
  });

  it('detects any edit to the record', () => {
    const keys = generateDeviceKey();
    const base = {
      ticketId: 'tkt_1',
      identityId: 'idn_1',
      eventId: EVENT,
      lane: 'lane_a',
      decidedAt: DOORS,
      outcome: 'admit' as const,
      code: 'MATCHED' as const,
      matchScore: 0.96,
      manifestSequence: 3,
      offline: true,
    };
    const a = signAttestation(base, SCANNER, keys.privateKeyPem);

    // Turning a denial into an admission after the fact is the thing this stops.
    expect(verifyAttestation({ ...a, outcome: 'deny' }, keys.publicKeyPem)).toBe(false);
    expect(verifyAttestation({ ...a, ticketId: 'tkt_2' }, keys.publicKeyPem)).toBe(false);
    expect(verifyAttestation({ ...a, decidedAt: DOORS + 1 }, keys.publicKeyPem)).toBe(false);
    expect(verifyAttestation({ ...a, offline: false }, keys.publicKeyPem)).toBe(false);
    expect(verifyAttestation({ ...a, scannerId: 'scn_other' }, keys.publicKeyPem)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the exit criterion: a scanner with the network off decides correctly', () => {
  it('admits, denies and falls back with no I/O of any kind', () => {
    const g = engine(roundTrip(manifest(50)));
    g.setOnline(false);

    // A real ticket-holder.
    const admitted = g.scan(capture(face(7), 0.2, 11), DOORS);
    expect(admitted.decision).toMatchObject({ outcome: 'admit', code: 'MATCHED', ticketId: 'tkt_0007' });
    expect(admitted.attestation.offline).toBe(true);

    // Somebody who is not on the list.
    const stranger = g.scan(capture(face(999), 0.2, 3), DOORS);
    expect(stranger.decision.outcome).toBe('fallback');
    expect(stranger.decision.code).toBe('NO_MATCH');

    // The same ticket a second time.
    const again = g.scan(capture(face(7), 0.2, 12), DOORS);
    expect(again.decision).toMatchObject({ outcome: 'deny', code: 'ALREADY_ADMITTED' });

    // Everything queued for upload, nothing lost.
    expect(g.status(DOORS).pendingUploads).toBe(3);
    expect(g.status(DOORS).online).toBe(false);
  });

  it('never denies on a poor match, however bad the capture', () => {
    const g = engine(roundTrip(manifest(20)));
    for (let seed = 1; seed <= 25; seed += 1) {
      const d = g.scan(capture(face(500 + seed), 0.9, seed), DOORS).decision;
      expect(d.outcome, `seed ${seed} produced a denial`).not.toBe('deny');
    }
  });

  it('routes an uncertain match to the resolution desk rather than guessing', () => {
    const g = engine(roundTrip(manifest(20)));
    // jitter 0.75 → cosine ≈ 0.64, inside the review band.
    const d = g.scan(capture(face(3), 0.75, 5), DOORS).decision;
    expect(d.outcome).toBe('fallback');
    expect(d.code).toBe('LOW_CONFIDENCE');
  });

  it('honours the admission window and the gate group offline', () => {
    const m = roundTrip(
      manifest(3, { entries: [entry(0), entry(1, { gates: ['south'] }), entry(2)] }),
    );
    const g = engine(m);

    expect(g.scan(capture(face(0), 0.2, 1), DOORS - 3_600_000).decision.code).toBe('TOO_EARLY');
    expect(g.scan(capture(face(1), 0.2, 1), DOORS).decision.code).toBe('WRONG_GATE');
    expect(g.scan(capture(face(2), 0.2, 1), DOORS + 9 * 3_600_000).decision.code).toBe('TOO_LATE');
  });

  it('falls back rather than failing open once the manifest expires', () => {
    const g = engine(roundTrip(manifest(5)));
    const d = g.scan(capture(face(1), 0.2, 1), EXPIRY + 1).decision;
    expect(d).toMatchObject({ outcome: 'fallback', code: 'MANIFEST_EXPIRED' });
  });
});

describe('the exit criterion: a resale revokes the seller at this lane', () => {
  it('stops admitting the seller the moment the delta lands', () => {
    const g = engine(roundTrip(manifest(10)));

    // Before the resale, the holder gets in.
    expect(g.scan(capture(face(4), 0.2, 21), DOORS).decision.outcome).toBe('admit');

    // The resale produces a rebind delta.
    const applied = g.applyDeltas([
      { seq: 1, kind: 'rebind', ticketId: 'tkt_0005' as never, identityId: 'idn_new' as never, templateRef: 'tpl_new' as never },
    ]);
    expect(applied.applied).toBe(1);
    expect(applied.gapDetected).toBe(false);

    // The previous holder of tkt_0005 is now denied, not merely unrecognised.
    const seller = g.scan(capture(face(5), 0.2, 22), DOORS).decision;
    expect(seller).toMatchObject({ outcome: 'deny', code: 'CREDENTIAL_REVOKED' });
  });

  it('stops at a gap rather than guessing past a possible revocation', () => {
    const g = engine(roundTrip(manifest(10)));

    // Delta 1 is missing. Applying 2 could admit somebody 1 had just revoked.
    const r = g.applyDeltas([
      { seq: 2, kind: 'revoke', ticketId: 'tkt_0003' as never, reason: 'chargeback' },
    ]);
    expect(r.applied).toBe(0);
    expect(r.gapDetected).toBe(true);
    expect(r.deferred).toBe(1);

    // tkt_0003 is still admitted, and the operator is warned the lane is behind.
    g.noteServerSequence(2);
    expect(g.status(DOORS).warn).toBe(true);
    expect(g.status(DOORS).behindBy).toBe(2);

    // The missing delta arrives; both apply, in order.
    const second = g.applyDeltas([{ seq: 1, kind: 'revoke', ticketId: 'tkt_0001' as never, reason: 'x' }]);
    expect(second.applied).toBe(2);
    expect(g.status(DOORS).behindBy).toBe(0);
    expect(g.scan(capture(face(3), 0.2, 9), DOORS).decision.code).toBe('CREDENTIAL_REVOKED');
  });

  it('is idempotent — a redelivered batch changes nothing', () => {
    const g = engine(roundTrip(manifest(10)));
    const batch = [{ seq: 1, kind: 'revoke' as const, ticketId: 'tkt_0002' as never, reason: 'x' }];
    expect(g.applyDeltas(batch).applied).toBe(1);
    expect(g.applyDeltas(batch).applied).toBe(0);
    expect(g.status(DOORS).sequence).toBe(1);
  });
});

describe('the operator sees how stale their lane is', () => {
  it('reports behind-by and warns', () => {
    const g = engine(roundTrip(manifest(4)));
    expect(g.status(DOORS).warn).toBe(false);

    g.noteServerSequence(6);
    const s = g.status(DOORS);
    expect(s.behindBy).toBe(6);
    expect(s.warn).toBe(true);
    expect(s.credentials).toBe(4);
  });

  it('flags an expired manifest in status, not just at scan time', () => {
    const g = engine(roundTrip(manifest(4)));
    expect(g.status(EXPIRY + 1).expired).toBe(true);
  });
});

describe('the upload queue', () => {
  it('holds decisions until the server acknowledges them', () => {
    const g = engine(roundTrip(manifest(5)));
    g.scan(capture(face(1), 0.2, 1), DOORS);
    g.scan(capture(face(2), 0.2, 1), DOORS);

    expect(g.pendingUploads()).toHaveLength(2);
    // Peeking does not consume: a failed upload must be retried, not lost.
    expect(g.pendingUploads()).toHaveLength(2);

    g.acknowledgeUploads(1);
    expect(g.status(DOORS).pendingUploads).toBe(1);
  });
});

describe('cryptographic erasure at TTL', () => {
  it('destroys every template and reports the count', () => {
    const g = engine(roundTrip(manifest(12)));
    const held = g.lookup('idn_0003');
    expect(held).toBeDefined();

    const result = g.erase();
    expect(result.erased).toBe(12);
    expect(g.status(EXPIRY - 1).credentials).toBe(0);
    expect(g.lookup('idn_0003')).toBeUndefined();

    // The vector the engine held is zeroed in place, not merely dereferenced.
    expect([...(held!.template as Float32Array)].every((x) => x === 0)).toBe(true);
  });
});

describe('the latency budget', () => {
  it('decides well inside 800 ms against a full-size gallery', () => {
    // 12,000 credentials — a real festival. This measures the match plus policy
    // path only; capture and embedding are the other 310 ms of the budget and
    // belong to the device's camera and model.
    const g = new GateEngine(manifest(12_000), {
      scannerId: SCANNER,
      lane: 'lane_bench',
      gateGroup: 'north',
      privateKeyPem: generateDeviceKey().privateKeyPem,
      allowReentry: false,
    });

    const samples: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      samples.push(g.scan(capture(face(i * 7), 0.2, i + 1), DOORS).elapsedMs);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;

    // Generous here on purpose: this runs on CI and dev laptops of unknown
    // speed, and the real number is the one `npm run bench:gate` prints on the
    // target device. This assertion exists to catch an accidental O(n²), not to
    // certify the budget.
    expect(p95).toBeLessThan(400);
  });

  it('compares against every credential, so the cost is understood not hidden', () => {
    const g = engine(roundTrip(manifest(200)));
    expect(g.scan(capture(face(1), 0.2, 1), DOORS).compared).toBe(200);
  });
});
