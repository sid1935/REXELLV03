import { extract } from './features.js';
import type { RawSignals } from './features.js';
import type { TrainingRow } from './scorer.js';

/**
 * Synthetic onsale traffic.
 *
 * Used to train the shipped model and to evaluate it. Everything below is a
 * modelling assumption, and the assumptions are the interesting part — a
 * classifier is only ever as honest as the traffic it was fitted to.
 *
 * ⚠ This is not real traffic and the numbers it produces are not real
 * performance. It demonstrates that the pipeline separates scripted from human
 * behaviour under the assumptions stated here. Real labels come from
 * chargebacks, gate denials and dedupe links, and the model must be refitted on
 * them before an onsale.
 */

export type Persona = 'human' | 'naive_bot' | 'evasive_bot' | 'human_farm';

/** Deterministic RNG, so a training run is reproducible. */
export function rng(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s = (Math.imul(s, 1_103_515_245) + 12_345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const pick = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);
const chance = (r: () => number, p: number) => r() < p;

/**
 * The fraction of each persona that is behaviourally INDISTINGUISHABLE from a
 * real fan — drawn from the human generator outright.
 *
 * This is the most important set of numbers in the file, and it is a claim about
 * the world rather than a parameter to tune. A scalper running one warmed
 * account per real device on a residential line, moving a real mouse, IS a human
 * session by every signal the edge can see. A paid worker in a farm is not
 * "like" a human; they are one.
 *
 * Encoding that here means the measured recall has a ceiling below 100%, which
 * is correct. A model that scores perfectly against its own traffic generator
 * has learned the generator, and reporting that number would be a lie told with
 * arithmetic.
 */
export const INDISTINGUISHABLE: Readonly<Record<Persona, number>> = Object.freeze({
  human: 0,
  naive_bot: 0,
  evasive_bot: 0.12,
  human_farm: 0.55,
});

export function generateSession(persona: Persona, r: () => number, index: number): RawSignals {
  // Drawn as a human, labelled as what it is. These are the sessions the
  // behavioural layer cannot win; the identity binding at the gate is what
  // actually handles them.
  if (persona !== 'human' && chance(r, INDISTINGUISHABLE[persona])) {
    return {
      ...generateSessionInner('human', r, index),
      sessionId: `ses_${persona}_${index}`,
      identityId: `idn_${persona}_${index}`,
      deviceFingerprint: `dev_${persona}_${index}`,
    };
  }
  return generateSessionInner(persona, r, index);
}

function generateSessionInner(persona: Persona, r: () => number, index: number): RawSignals {

  const sessionId = `ses_${persona}_${index}`;
  const base = {
    sessionId,
    identityId: `idn_${persona}_${index}`,
    deviceFingerprint: `dev_${persona}_${index}`,
  };

  switch (persona) {
    case 'human': {
      // Irregular rhythm, real pointer movement, one device — usually.
      //
      // The tail matters more than the mode. A tenth of real fans look
      // superficially like a farm: a family sharing one tablet and one card, a
      // hostel on one connection, somebody who has bought forty times and knows
      // exactly where to click. Every one of them is why the false-block rate is
      // the number that ends up on social media.
      const shared = chance(r, 0.14);
      const practised = chance(r, 0.18);
      const intervals = Array.from({ length: 6 }, () =>
        practised ? pick(r, 250, 1_400) : pick(r, 400, 6_000),
      );
      return {
        ...base,
        asn: 9829,
        asnIsDatacenter: false,
        deviceAttested: chance(r, 0.9),
        dwellMs: practised ? pick(r, 300, 3_000) : pick(r, 2_000, 30_000),
        interActionMs: intervals,
        pointerTurnsPer100px: pick(r, 0.8, 9),
        pointerObserved: chance(r, 0.97), // a keyboard-only user
        accountAgeHours: chance(r, 0.15) ? pick(r, 0.2, 40) : pick(r, 24, 20_000),
        requestsLastMinute: practised ? pick(r, 15, 55) : pick(r, 3, 25),
        accountsOnDevice: shared ? Math.floor(pick(r, 2, 7)) : 1,
        accountsOnCard: shared ? Math.floor(pick(r, 2, 6)) : 1,
        seatSelectionMs: practised ? pick(r, 700, 6_000) : pick(r, 3_000, 45_000),
      };
    }

    case 'naive_bot': {
      // A script with a fixed sleep. Fast, regular, headless, datacentre.
      const period = pick(r, 60, 260);
      return {
        ...base,
        asn: 16509,
        asnIsDatacenter: true,
        deviceAttested: false,
        dwellMs: pick(r, 5, 150),
        interActionMs: Array.from({ length: 6 }, () => period),
        pointerTurnsPer100px: 0,
        pointerObserved: false,
        accountAgeHours: pick(r, 0, 48),
        requestsLastMinute: pick(r, 60, 600),
        accountsOnDevice: Math.floor(pick(r, 5, 40)),
        accountsOnCard: Math.floor(pick(r, 3, 25)),
        seatSelectionMs: pick(r, 10, 200),
      };
    }

    case 'evasive_bot': {
      // The realistic adversary: residential proxy, randomised delays, synthetic
      // pointer paths, warmed accounts. Slower and more expensive to run, which
      // is the actual goal — detection that merely raises the cost is working.
      // A third of them run one warmed account per device with its own card.
      // That is expensive, which is the point — but it means the graph features
      // are blind to them and only behaviour is left.
      const clean = chance(r, 0.33);
      const intervals = Array.from({ length: 6 }, () => pick(r, 700, 4_500));
      return {
        ...base,
        asn: 24560,
        asnIsDatacenter: false,
        deviceAttested: chance(r, clean ? 0.85 : 0.35),
        dwellMs: pick(r, 900, 8_000),
        interActionMs: intervals,
        pointerTurnsPer100px: pick(r, 0.4, 4),
        pointerObserved: true,
        accountAgeHours: pick(r, 72, 4_000),
        requestsLastMinute: pick(r, 15, 90),
        accountsOnDevice: clean ? 1 : Math.floor(pick(r, 2, 12)),
        accountsOnCard: clean ? 1 : Math.floor(pick(r, 2, 10)),
        seatSelectionMs: pick(r, 700, 6_000),
      };
    }

    case 'human_farm': {
      // Paid humans on real devices. Behaviourally they ARE human, because they
      // are, so the behavioural features barely help. What gives them away is
      // the graph: shared cards, clustered devices, brand-new accounts. This
      // persona exists in the training set to keep the model honest about what
      // it cannot see.
      // Each worker has their own phone, so device sharing barely shows. The
      // shared card is the one edge left, and half of them use prepaid cards to
      // remove even that.
      const intervals = Array.from({ length: 6 }, () => pick(r, 500, 5_000));
      const prepaid = chance(r, 0.5);
      return {
        ...base,
        asn: 45609,
        asnIsDatacenter: false,
        deviceAttested: true,
        dwellMs: pick(r, 1_500, 15_000),
        interActionMs: intervals,
        pointerTurnsPer100px: pick(r, 1.2, 8),
        pointerObserved: true,
        accountAgeHours: pick(r, 1, 400),
        requestsLastMinute: pick(r, 5, 30),
        accountsOnDevice: chance(r, 0.7) ? 1 : Math.floor(pick(r, 2, 4)),
        accountsOnCard: prepaid ? 1 : Math.floor(pick(r, 3, 12)),
        seatSelectionMs: pick(r, 2_000, 25_000),
      };
    }
  }
}

export interface TrafficMix {
  readonly human: number;
  readonly naive_bot: number;
  readonly evasive_bot: number;
  readonly human_farm: number;
}

export const DEFAULT_MIX: TrafficMix = Object.freeze({
  human: 700,
  naive_bot: 150,
  evasive_bot: 120,
  human_farm: 60,
});

export interface LabelledSession {
  readonly persona: Persona;
  readonly signals: RawSignals;
  readonly label: number;
}

export function generateTraffic(mix: TrafficMix, seed: number): LabelledSession[] {
  const r = rng(seed);
  const out: LabelledSession[] = [];
  for (const [persona, count] of Object.entries(mix) as Array<[Persona, number]>) {
    for (let i = 0; i < count; i += 1) {
      out.push({
        persona,
        signals: generateSession(persona, r, i),
        // human_farm is labelled 1 — it IS scalping — which means the model is
        // being asked to catch something the behavioural features cannot see,
        // and its measured recall is honest about that rather than flattered.
        label: persona === 'human' ? 0 : 1,
      });
    }
  }
  return out;
}

export function toTrainingRows(sessions: readonly LabelledSession[]): TrainingRow[] {
  return sessions.map((s) => ({ features: extract(s.signals), label: s.label }));
}
