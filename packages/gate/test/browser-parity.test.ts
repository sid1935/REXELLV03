import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalAttestation } from '../src/index.js';
import type { Attestation } from '../src/index.js';

/**
 * The browser scanner and the Node engine must produce byte-identical canonical
 * forms.
 *
 * If they drift, every attestation the PWA signs fails verification at upload —
 * silently, and only under real traffic, because the two implementations are in
 * different languages in different repos-worth of code and nothing else connects
 * them. So this test reaches into `apps/scanner/public/scanner.js`, pulls out its
 * `canonical()` function, and runs both over the same records.
 *
 * It is an unusual test. It exists because the alternative is discovering the
 * mismatch at a gate.
 */
const SCANNER_JS = fileURLToPath(new URL('../../../apps/scanner/public/scanner.js', import.meta.url));

function browserCanonical(): (a: Record<string, unknown>) => string {
  const source = readFileSync(SCANNER_JS, 'utf8');
  const match = source.match(/function canonical\(a\)\s*\{[\s\S]*?\n\}/);
  if (!match) throw new Error('could not find canonical() in scanner.js — did it get renamed?');
  return new Function(`${match[0]}; return canonical;`)() as (a: Record<string, unknown>) => string;
}

describe('the browser scanner signs the same bytes as the engine', () => {
  const canonical = browserCanonical();

  const cases: Array<{ name: string; a: Attestation; scannerId: string }> = [
    {
      name: 'an ordinary admission',
      scannerId: 'scn_lane_1',
      a: {
        ticketId: 'tkt_0001',
        identityId: 'idn_0001',
        eventId: 'evt_sunburn26',
        lane: 'lane_1',
        decidedAt: 1_780_000_000_000,
        outcome: 'admit',
        code: 'MATCHED',
        matchScore: 0.9612345,
        manifestSequence: 42,
        offline: false,
      },
    },
    {
      name: 'an offline denial',
      scannerId: 'scn_lane_9',
      a: {
        ticketId: 'tkt_9999',
        identityId: 'idn_9999',
        eventId: 'evt_x',
        lane: 'lane_9',
        decidedAt: 1_780_000_123_456,
        outcome: 'deny',
        code: 'CREDENTIAL_REVOKED',
        matchScore: 0.5,
        manifestSequence: 0,
        offline: true,
      },
    },
    {
      name: 'a fallback with an unknown ticket',
      scannerId: 'scn_lane_3',
      a: {
        ticketId: 'unknown',
        identityId: 'unknown',
        eventId: 'evt_x',
        lane: 'lane_3',
        decidedAt: 1,
        outcome: 'fallback',
        code: 'NO_MATCH',
        matchScore: 0,
        manifestSequence: 7,
        offline: true,
      },
    },
    {
      name: 'a score that rounds awkwardly',
      scannerId: 'scn_lane_2',
      a: {
        ticketId: 'tkt_5',
        identityId: 'idn_5',
        eventId: 'evt_x',
        lane: 'lane_2',
        decidedAt: 2,
        outcome: 'admit',
        code: 'REENTRY',
        // The float formatting is the likeliest place for the two to diverge:
        // both must use toFixed(6), not String() and not JSON.
        matchScore: 0.1 + 0.2,
        manifestSequence: 1,
        offline: false,
      },
    },
  ];

  for (const { name, a, scannerId } of cases) {
    it(name, () => {
      const fromEngine = canonicalAttestation(a, scannerId);
      const fromBrowser = canonical({ ...a, scannerId });
      expect(fromBrowser).toBe(fromEngine);
    });
  }

  it('includes every field that matters, so no edit is invisible to a signature', () => {
    const base: Attestation = {
      ticketId: 'tkt_1',
      identityId: 'idn_1',
      eventId: 'evt_1',
      lane: 'lane_1',
      decidedAt: 1000,
      outcome: 'admit',
      code: 'MATCHED',
      matchScore: 0.9,
      manifestSequence: 1,
      offline: false,
    };
    const original = canonicalAttestation(base, 'scn_1');

    const mutations: Array<Partial<Attestation> & { scannerId?: string }> = [
      { ticketId: 'tkt_2' },
      { identityId: 'idn_2' },
      { eventId: 'evt_2' },
      { lane: 'lane_2' },
      { decidedAt: 1001 },
      { outcome: 'deny' },
      { code: 'ALREADY_ADMITTED' },
      { matchScore: 0.91 },
      { manifestSequence: 2 },
      { offline: true },
      { scannerId: 'scn_2' },
    ];

    for (const m of mutations) {
      const { scannerId = 'scn_1', ...rest } = m;
      const changed = canonicalAttestation({ ...base, ...rest }, scannerId);
      expect(changed, `changing ${Object.keys(m)[0]} did not change the signed bytes`).not.toBe(original);
    }
  });
});
