import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CALIBRATED_BANDS,
  DEFAULT_MIX,
  FEATURE_NAMES,
  FairQueue,
  INDISTINGUISHABLE,
  MODEL,
  Scorer,
  buildEdges,
  cluster,
  evaluate,
  extract,
  generateTraffic,
  intervalCv,
  riskMultipliers,
  verdictFor,
} from '../src/index.js';
import type { Bands, Observation, RawSignals } from '../src/index.js';

const BANDS = CALIBRATED_BANDS as Bands;
const scorer = new Scorer(MODEL, BANDS);

const human: RawSignals = {
  sessionId: 'ses_h',
  deviceFingerprint: 'dev_h',
  asn: 9829,
  asnIsDatacenter: false,
  deviceAttested: true,
  dwellMs: 12_000,
  interActionMs: [800, 4_200, 1_100, 6_000, 2_300, 900],
  pointerTurnsPer100px: 4.2,
  pointerObserved: true,
  accountAgeHours: 9_000,
  requestsLastMinute: 8,
  accountsOnDevice: 1,
  accountsOnCard: 1,
  seatSelectionMs: 18_000,
};

const bot: RawSignals = {
  sessionId: 'ses_b',
  deviceFingerprint: 'dev_b',
  asn: 16509,
  asnIsDatacenter: true,
  deviceAttested: false,
  dwellMs: 40,
  interActionMs: [120, 120, 120, 120, 120, 120],
  pointerTurnsPer100px: 0,
  pointerObserved: false,
  accountAgeHours: 2,
  requestsLastMinute: 300,
  accountsOnDevice: 22,
  accountsOnCard: 14,
  seatSelectionMs: 60,
};

// ─── features ────────────────────────────────────────────────────────────────

describe('feature extraction', () => {
  it('separates a regular rhythm from an irregular one', () => {
    // The signal that survives the most effort to defeat.
    expect(intervalCv([120, 120, 120, 120])).toBe(0);
    expect(intervalCv([400, 5_000, 900, 3_200])).toBeGreaterThan(0.5);
  });

  it('is total — never NaN, never Infinity, whatever it is handed', () => {
    // A NaN reaching the scorer produces a NaN score, which compares false
    // against every threshold and therefore silently ADMITS.
    const nasty: RawSignals = {
      ...human,
      dwellMs: Number.NaN,
      interActionMs: [],
      accountAgeHours: -5,
      requestsLastMinute: Number.POSITIVE_INFINITY,
      seatSelectionMs: Number.NaN,
    };
    for (const value of extract(nasty)) expect(Number.isFinite(value)).toBe(true);
    expect(Number.isFinite(scorer.scoreVector(extract(nasty)))).toBe(true);
  });

  it('is deterministic — the same signals give the same vector every time', () => {
    expect([...extract(human)]).toEqual([...extract(human)]);
  });

  it('the exit criterion for the feature store: online and offline agree exactly', () => {
    // There is one transform and both paths call it. This test exists to fail
    // loudly if somebody ever adds a second one — training/serving skew is
    // silent, looks like a mysterious accuracy drop, and is the most common way
    // an ML system quietly stops working.
    const sessions = generateTraffic({ human: 40, naive_bot: 10, evasive_bot: 10, human_farm: 5 }, 42);

    // "Online": extracted per request, at the edge, one at a time.
    const online = sessions.map((s) => [...extract(s.signals)]);
    // "Offline": the same events replayed later in a batch job.
    const replayed = JSON.parse(JSON.stringify(sessions)) as typeof sessions;
    const offline = replayed.map((s) => [...extract(s.signals)]);

    expect(offline).toEqual(online);
  });
});

// ─── the scorer ──────────────────────────────────────────────────────────────

describe('the inline scorer', () => {
  it('scores an obvious script high and an obvious fan low', () => {
    expect(scorer.score(bot).score).toBeGreaterThan(0.9);
    expect(scorer.score(human).score).toBeLessThan(0.2);
  });

  it('explains itself, because a blocked fan deserves a reason', () => {
    const result = scorer.score(bot);
    expect(result.topReasons.length).toBeGreaterThan(0);
    for (const reason of result.topReasons) {
      expect(FEATURE_NAMES).toContain(reason.feature);
    }
  });

  it('refuses to load a model whose feature order does not match the extractor', () => {
    // Every coefficient after the mismatch would be applied to the wrong number,
    // silently, and the model would still return plausible-looking scores.
    const reordered = { ...MODEL, featureNames: [...MODEL.featureNames].reverse() };
    expect(() => new Scorer(reordered)).toThrow(/feature order changed/);
    expect(() => new Scorer({ ...MODEL, featureNames: ['a', 'b'] })).toThrow(/fit against 2 features/);
  });

  it('reserves blocking for the top of the range and prefers friction below it', () => {
    expect(verdictFor(0, BANDS)).toBe('allow');
    expect(verdictFor(BANDS.challenge, BANDS)).toBe('challenge');
    expect(verdictFor(BANDS.throttle, BANDS)).toBe('throttle');
    expect(verdictFor(BANDS.block, BANDS)).toBe('block');
    expect(BANDS.challenge).toBeLessThan(BANDS.block);
  });

  it('meets the p99 budget with room to spare', () => {
    // 50 ms is the architecture's inline budget. A stump ensemble is a few dozen
    // comparisons, so this is met by construction — the test guards against
    // somebody adding an I/O call to the hot path.
    const v = extract(bot);
    const samples: number[] = [];
    for (let i = 0; i < 5_000; i += 1) {
      const t = performance.now();
      scorer.scoreVector(v);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)] ?? 0;
    expect(p99).toBeLessThan(1);
  });
});

describe('the exit criterion: a scripted run is stopped, a human run passes', () => {
  /**
   * Pooled over ten independent samples rather than one.
   *
   * A single run of 270 scripted sessions estimates the block rate to about
   * ±3 points, and the true rate sits close enough to the 95% line that one
   * sample lands either side of it depending on the seed. Reporting whichever
   * seed passed would be picking a number rather than measuring one.
   */
  const SEEDS = [999_777, 111_222, 333_444, 555_666, 777_888, 121_212, 343_434, 565_656, 787_878, 909_090];
  const pooled = SEEDS.flatMap((seed) =>
    generateTraffic(DEFAULT_MIX, seed).map((s) => ({
      persona: s.persona,
      features: extract(s.signals),
      label: s.label,
    })),
  );
  const holdout = pooled;

  const scripted = pooled.filter((r) => r.persona === 'naive_bot' || r.persona === 'evasive_bot');
  const evasiveCount = pooled.filter((r) => r.persona === 'evasive_bot').length;

  /**
   * The most a behavioural model could possibly achieve here.
   *
   * 12% of evasive bots are drawn from the human generator outright — they are
   * not "similar to" a human session, they ARE one. No amount of model capacity
   * recovers those, so this is an information limit, not a tuning target.
   */
  const CEILING = (scripted.length - evasiveCount * INDISTINGUISHABLE.evasive_bot) / scripted.length;

  it('extracts essentially all the signal that behaviour contains', () => {
    const stopped = scripted.filter((r) => scorer.scoreVector(r.features) >= BANDS.throttle).length;
    const rate = stopped / scripted.length;

    const perSeed = SEEDS.map((seed) => {
      const rows = generateTraffic(DEFAULT_MIX, seed)
        .filter((s) => s.persona === 'naive_bot' || s.persona === 'evasive_bot')
        .map((s) => extract(s.signals));
      return rows.filter((f) => scorer.scoreVector(f) >= BANDS.throttle).length / rows.length;
    });
    const lo = Math.min(...perSeed);
    const hi = Math.max(...perSeed);

    // Within a point of the ceiling. The meaningful assertion is not a round
    // number like 95% — it is that the model leaves almost nothing on the table.
    expect(
      rate,
      `pooled ${(rate * 100).toFixed(1)}% of ${scripted.length}; ceiling ${(CEILING * 100).toFixed(1)}%; per-sample ${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%`,
    ).toBeGreaterThan(CEILING - 0.01);
  });

  it('documents that >95% is NOT reachable by behaviour alone under these assumptions', () => {
    // The M5 exit criterion asks for >95%. The ceiling is below that, so the
    // criterion cannot be met by the inline scorer however good it gets. This
    // test exists so that fact is asserted rather than buried in a report — if
    // somebody later lowers INDISTINGUISHABLE to make a number look better, this
    // fails and makes them say so out loud.
    expect(CEILING).toBeLessThan(0.95);
  });

  it('the graph layer covers what behaviour cannot', () => {
    // A farm of twelve workers on twelve real phones sharing one operator card.
    // Behaviourally they are twelve fans. The shared instrument is the only edge,
    // and it is enough.
    const farm: Observation[] = Array.from({ length: 12 }, (_, i) => ({
      identityId: `idn_farm_${i}`,
      deviceFingerprint: `dev_worker_${i}`,
      cardFingerprint: 'card_operator',
    }));
    const multipliers = riskMultipliers(cluster(buildEdges(farm)));

    // Every member picks up a multiplier, applied at the NEXT onsale.
    expect(multipliers.size).toBe(12);
    for (const id of farm.map((o) => o.identityId)) {
      expect(multipliers.get(id)).toBeGreaterThan(1.5);
    }

    // A lift in log-odds large enough to move a mid-band score over the line.
    const borderline = 0.30;
    const multiplier = multipliers.get('idn_farm_0') as number;
    const lifted = 1 / (1 + Math.exp(-(Math.log(borderline / (1 - borderline)) + Math.log2(multiplier))));
    expect(lifted).toBeGreaterThan(BANDS.throttle);
  });

  it('lets the human control run through', () => {
    const result = evaluate(scorer, holdout, BANDS);
    // The number that ends up on social media if it is wrong.
    expect(result.humanFalseBlockRate).toBeLessThan(0.02);
    expect(result.humanFrictionRate).toBeLessThan(0.08);
  });

  it('does not pretend to catch human farms, and says so in the numbers', () => {
    // Paid humans on real devices ARE humans by every signal here. Behavioural
    // detection tops out well below useful, and that is the honest result — the
    // identity binding at the gate is what handles them, not this model.
    const farm = holdout.filter((r) => r.persona === 'human_farm');
    const stopped = farm.filter((r) => scorer.scoreVector(r.features) >= BANDS.throttle).length;
    const rate = stopped / farm.length;
    expect(rate).toBeLessThan(0.5);
    expect(INDISTINGUISHABLE.human_farm).toBeGreaterThan(0.5);
  });
});

// ─── the fair queue ──────────────────────────────────────────────────────────

const queueConfig = { drainPerSecond: 200, tokenTtlMs: 120_000, secret: randomBytes(32) };

describe('the exit criterion: the edge absorbs an onsale surge', () => {
  it('releases at the origin rate however many arrive at once', () => {
    // 40,000 sessions arriving inside one second, against an origin that can
    // serve 200 per second. Nothing about the arrival rate may reach it.
    const q = new FairQueue(queueConfig);
    const t0 = 1_780_000_000_000;

    for (let i = 0; i < 40_000; i += 1) q.join(`ses_${i}`, `dev_${i}`, t0);
    expect(q.status(t0).waiting).toBe(40_000);

    // One second later, exactly the drain rate has been released.
    const first = q.drain(t0 + 1_000);
    expect(first).toHaveLength(200);

    // Ten more seconds, ten more batches. The origin never sees a spike.
    let released = first.length;
    for (let s = 2; s <= 11; s += 1) released += q.drain(t0 + s * 1_000).length;
    expect(released).toBe(2_200);

    const status = q.status(t0 + 11_000);
    expect(status.totalArrivals).toBe(40_000);
    expect(status.totalAdmitted).toBe(2_200);
    expect(status.waiting).toBe(37_800);
    // And the fan is told how long, rather than left refreshing.
    expect(status.estimatedDrainMs).toBe(189_000);
  });

  it('never exceeds the origin rate over any window', () => {
    const q = new FairQueue(queueConfig);
    const t0 = 1_780_000_000_000;
    for (let i = 0; i < 40_000; i += 1) q.join(`ses_${i}`, `dev_${i}`, t0);

    let peak = 0;
    for (let tick = 1; tick <= 60; tick += 1) {
      const n = q.drain(t0 + tick * 1_000).length;
      peak = Math.max(peak, n);
    }
    expect(peak).toBeLessThanOrEqual(queueConfig.drainPerSecond);
  });

  it('handles the whole surge in bounded time and memory', () => {
    const q = new FairQueue({ ...queueConfig, drainPerSecond: 2_000 });
    const t0 = 1_780_000_000_000;
    const started = performance.now();
    for (let i = 0; i < 40_000; i += 1) q.join(`ses_${i}`, `dev_${i}`, t0);
    const elapsed = performance.now() - started;
    // Admission control must not itself become the bottleneck.
    expect(elapsed).toBeLessThan(2_000);
    expect(q.status(t0).waiting).toBe(40_000);
  });
});

describe('the queue is winnable by a person', () => {
  it('gives a session the place it already had, however often it rejoins', () => {
    // Strict first-come-first-served is won by whoever opens the most
    // connections. Rejoining must buy nothing.
    const q = new FairQueue(queueConfig);
    const t0 = 1_000_000;

    q.join('ses_a', 'idn_a', t0);
    q.join('ses_b', 'idn_b', t0 + 1);
    const first = q.join('ses_c', 'idn_c', t0 + 2);
    expect(first.position).toBe(3);

    for (let i = 0; i < 500; i += 1) {
      const again = q.join(`ses_c_alt_${i}`, 'idn_c', t0 + 3 + i);
      expect(again.rejoined).toBe(true);
      expect(again.position).toBe(3);
    }
    expect(q.status(t0).waiting).toBe(3);
    expect(q.status(t0).rejoins).toBe(500);
  });

  it('admits by lottery within a batch, so being milliseconds earlier buys nothing', () => {
    const q = new FairQueue({ ...queueConfig, drainPerSecond: 10, lottery: true });
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i += 1) q.join(`ses_${i}`, `dev_${i}`, t0 + i);

    const admitted = q.drain(t0 + 1_000);
    expect(admitted).toHaveLength(10);
    // Not simply the first ten by arrival.
    const strictlyOrdered = admitted.every((id, i) => id === `ses_${i}`);
    expect(strictlyOrdered).toBe(false);
  });
});

describe('admission tokens', () => {
  it('round-trips and admits once', () => {
    const q = new FairQueue(queueConfig);
    const t0 = 1_000_000;
    const token = q.issueToken('ses_a', t0);

    expect(q.redeem(token, 'ses_a', t0 + 1_000)).toMatchObject({ ok: true });
    // Single use, so one admission cannot become a thousand purchases.
    expect(q.redeem(token, 'ses_a', t0 + 1_001)).toMatchObject({ ok: false, reason: 'ALREADY_USED' });
  });

  it('refuses a forged, expired, or borrowed token', () => {
    const q = new FairQueue(queueConfig);
    const t0 = 1_000_000;
    const token = q.issueToken('ses_a', t0);

    expect(q.redeem('nonsense', 'ses_a', t0)).toMatchObject({ reason: 'MALFORMED' });
    expect(q.redeem(`${token}x`, 'ses_a', t0)).toMatchObject({ reason: 'BAD_SIGNATURE' });
    expect(q.redeem(token, 'ses_a', t0 + queueConfig.tokenTtlMs)).toMatchObject({ reason: 'EXPIRED' });
    // A token handed to another session — the obvious way to resell admission.
    expect(q.redeem(token, 'ses_b', t0 + 1_000)).toMatchObject({ reason: 'WRONG_SESSION' });
  });

  it('cannot be minted by anyone without the edge key', () => {
    const edge = new FairQueue(queueConfig);
    const attacker = new FairQueue({ ...queueConfig, secret: randomBytes(32) });
    const forged = attacker.issueToken('ses_a', 1_000_000);
    expect(edge.redeem(forged, 'ses_a', 1_000_001)).toMatchObject({ reason: 'BAD_SIGNATURE' });
  });
});

// ─── the graph ───────────────────────────────────────────────────────────────

describe('finding the farm rather than the bot', () => {
  it('clusters accounts that share a card and a device', () => {
    const observations: Observation[] = [
      { identityId: 'idn_1', deviceFingerprint: 'dev_x', cardFingerprint: 'card_1' },
      { identityId: 'idn_2', deviceFingerprint: 'dev_x', cardFingerprint: 'card_1' },
      { identityId: 'idn_3', deviceFingerprint: 'dev_y', cardFingerprint: 'card_1' },
      { identityId: 'idn_4', deviceFingerprint: 'dev_y', cardFingerprint: 'card_1' },
      { identityId: 'idn_5', deviceFingerprint: 'dev_z', cardFingerprint: 'card_1' },
      // Unrelated.
      { identityId: 'idn_9', deviceFingerprint: 'dev_q', cardFingerprint: 'card_9' },
    ];

    const clusters = cluster(buildEdges(observations));
    const farm = clusters[0];
    expect(farm?.size).toBe(5);
    expect(farm?.suspicious).toBe(true);
    expect(farm?.identities).not.toContain('idn_9');
  });

  it('weighs a biometric dedupe link far above a shared network', () => {
    const dedupe = cluster(
      buildEdges([{ identityId: 'idn_a', dedupeMatchedIdentity: 'idn_b' }]),
    );
    const sharedAsn = cluster(
      buildEdges([
        { identityId: 'idn_c', asn: 12345 },
        { identityId: 'idn_d', asn: 12345 },
      ]),
    );
    expect(dedupe[0]!.score).toBeGreaterThan(sharedAsn[0]!.score * 10);
  });

  it('refuses to merge a whole campus into one farm', () => {
    // Six hundred students behind one NAT is infrastructure, not a scalper. A
    // naive implementation produces one giant cluster and flags everybody.
    const campus: Observation[] = Array.from({ length: 600 }, (_, i) => ({
      identityId: `idn_student_${i}`,
      asn: 55555,
    }));
    const clusters = cluster(buildEdges(campus));
    expect(clusters).toHaveLength(0);
  });

  it('produces a risk multiplier for the next onsale, not this one', () => {
    const observations: Observation[] = Array.from({ length: 8 }, (_, i) => ({
      identityId: `idn_${i}`,
      deviceFingerprint: 'dev_shared',
      cardFingerprint: 'card_shared',
    }));
    const multipliers = riskMultipliers(cluster(buildEdges(observations)));
    expect(multipliers.get('idn_0')).toBeGreaterThan(1);
    // Flattens, so a hundred-account farm is not scored a hundred times worse
    // than a ten-account one. Both are farms.
    expect(multipliers.get('idn_0')).toBeLessThanOrEqual(3);
  });

  it('finds nothing when there is nothing to find', () => {
    const clean: Observation[] = Array.from({ length: 50 }, (_, i) => ({
      identityId: `idn_${i}`,
      deviceFingerprint: `dev_${i}`,
      cardFingerprint: `card_${i}`,
    }));
    expect(cluster(buildEdges(clean)).filter((c) => c.suspicious)).toHaveLength(0);
  });

  it('catches the farm the behavioural model misses', () => {
    // The point of the whole layer. These sessions score low inline — they are
    // real people on real phones — and the shared card is what gives them away.
    const farm: Observation[] = Array.from({ length: 12 }, (_, i) => ({
      identityId: `idn_farm_${i}`,
      deviceFingerprint: `dev_worker_${i}`,
      cardFingerprint: 'card_operator',
    }));
    const clusters = cluster(buildEdges(farm));
    expect(clusters[0]?.suspicious).toBe(true);
    expect(clusters[0]?.edgeCounts.card).toBeGreaterThan(0);
    expect(clusters[0]?.edgeCounts.device).toBe(0);
  });
});
