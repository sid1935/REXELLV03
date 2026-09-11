/**
 * Liveness evidence, and the attacks it exists to stop.
 *
 * The frames are built from real descriptors — `real-faces.json`, produced by
 * the browser matcher — so "the same person across the sequence" and "somebody
 * else spliced in" are the real distances between real faces rather than
 * numbers chosen to make the test pass.
 *
 * The pose is synthesised, because a photograph has one pose and a sequence
 * needs a trajectory. That is the honest boundary of this file: it proves the
 * server judges a trajectory correctly, not that the browser measures one
 * correctly. The measuring is checked separately, against photographs of turned
 * heads, in `face-capture.js`.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_EVIDENCE_LIMITS as L, judgeEvidence } from '../src/liveness.js';
import type { ChallengeKind, LivenessFrame } from '../src/liveness.js';
import faces from './real-faces.json' with { type: 'json' };

interface Face {
  person: string;
  photo: string;
  vector: number[];
}
const all = faces as Face[];
const photosOf = (person: string) => all.filter((f) => f.person === person);
const SUBJECT = 'watson';
const OTHER = 'merkel';

function lcg(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s = (Math.imul(s, 1_103_515_245) + 12_345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * One frame's worth of sensor noise on a real descriptor.
 *
 * Two consecutive frames of a camera pointed at a motionless face are very
 * alike and never identical. Building the sequence by repeating one descriptor
 * — as the first version of this file did — trips the duplicate check on every
 * test, which is the check working correctly against a bad fixture.
 */
function jitter(vector: number[], seed: number): number[] {
  const rand = lcg(seed);
  const noisy = vector.map((x) => x + (rand() * 2 - 1) * 0.015);
  const mag = Math.hypot(...noisy);
  return noisy.map((x) => x / mag);
}

/**
 * A plausible capture: twelve frames over two seconds, starting square on.
 *
 * Each frame is one of the subject's real descriptors with a different
 * frame's worth of noise on it, so the sequence is one person, twelve times,
 * and never the same capture twice.
 */
function sequence(over: Partial<LivenessFrame>[] = [], person = SUBJECT): LivenessFrame[] {
  const pool = photosOf(person);
  return Array.from({ length: 12 }, (_, i) => ({
    at: i * 180,
    yaw: 0,
    pitch: 0,
    eyeOpen: 0.3,
    vector: jitter(pool[i % pool.length]!.vector, i + 1),
    ...(over[i] ?? {}),
  }));
}

/** A completed movement of the requested kind, starting from centre. */
function performing(kind: ChallengeKind): LivenessFrame[] {
  const over: Partial<LivenessFrame>[] = [];
  for (let i = 0; i < 12; i += 1) {
    // Sit at centre for the first four frames, then move.
    const t = Math.max(0, (i - 3) / 8);
    if (kind === 'turn_left') over[i] = { yaw: t * 0.5 };
    if (kind === 'turn_right') over[i] = { yaw: -t * 0.5 };
    if (kind === 'nod') over[i] = { pitch: t * 0.6 };
    if (kind === 'blink') over[i] = { eyeOpen: i === 7 || i === 8 ? 0.05 : 0.3 };
  }
  return sequence(over);
}

describe('liveness evidence', () => {
  const KINDS: ChallengeKind[] = ['turn_left', 'turn_right', 'nod', 'blink'];

  it('accepts somebody doing what they were asked', () => {
    for (const kind of KINDS) {
      expect(judgeEvidence(kind, performing(kind)), kind).toEqual({ ok: true });
    }
  });

  it('refuses somebody doing a different movement from the one asked for', () => {
    // The point of the server picking. A video recorded in advance can contain
    // one of these; it cannot contain the one that will be asked for.
    for (const asked of KINDS) {
      for (const did of KINDS) {
        if (asked === did) continue;
        const verdict = judgeEvidence(asked, performing(did));
        expect(verdict.ok, `asked ${asked}, was given ${did}`).toBe(false);
      }
    }
  });

  describe('a photograph held up to the camera', () => {
    it('is refused when it is held square on, because paper does not turn', () => {
      const still = sequence(); // perfectly centred, never moves
      for (const kind of KINDS) {
        expect(judgeEvidence(kind, still), kind).toEqual({ ok: false, reason: 'MOVEMENT_NOT_OBSERVED' });
      }
    });

    it('is refused when it is held at an angle from the start', () => {
      // Held at a constant angle, which is what a print in a stand looks like.
      // Measuring from the resting pose catches this for the reason that
      // matters: paper has no range, wherever it is pointed.
      const angled = sequence(Array.from({ length: 12 }, () => ({ yaw: 0.5 })));
      expect(judgeEvidence('turn_left', angled)).toEqual({ ok: false, reason: 'MOVEMENT_NOT_OBSERVED' });
    });

    it('is refused when it drifts but never travels far enough', () => {
      // A hand that is not quite steady is not a turn.
      const drifting = sequence(Array.from({ length: 12 }, (_, i) => ({ yaw: 0.3 + i * 0.008 })));
      expect(judgeEvidence('turn_left', drifting)).toEqual({ ok: false, reason: 'MOVEMENT_NOT_OBSERVED' });
    });

    it('IS accepted when the photograph is physically rotated far enough', () => {
      /*
       * Documented, not desirable. Rotating a flat print really does foreshorten
       * the landmarks and really does read as a turn, and it defeated the
       * previous absolute-pose version of this check too — an attacker only had
       * to start square on, which is easier rather than harder. So this is the
       * limit the product already states, pinned here so nobody mistakes the
       * relative rule for a regression against an attack that was ever stopped.
       */
      const rotated = sequence(Array.from({ length: 12 }, (_, i) => ({ yaw: Math.max(0, (i - 3) / 8) * 0.5 })));
      expect(judgeEvidence('turn_left', rotated)).toEqual({ ok: true });
    });
  });

  describe('a fabricated sequence', () => {
    it('is refused when one frame is repeated to pad it out', () => {
      const one = photosOf(SUBJECT)[0]!.vector;
      const padded = sequence(Array.from({ length: 12 }, (_, i) => ({ yaw: i >= 4 ? 0.5 : 0, vector: one })));
      expect(judgeEvidence('turn_left', padded)).toEqual({ ok: false, reason: 'FRAMES_REPEATED' });
    });

    it('is refused when somebody else is spliced in to supply the movement', () => {
      const mine = photosOf(SUBJECT);
      const theirs = photosOf(OTHER);
      const spliced = sequence(
        Array.from({ length: 12 }, (_, i) => ({
          yaw: i >= 4 ? 0.5 : 0,
          // The turned half is a different person entirely.
          vector: jitter((i >= 6 ? theirs : mine)[i % 3]!.vector, i + 1),
        })),
      );
      expect(judgeEvidence('turn_left', spliced)).toEqual({ ok: false, reason: 'NOT_ONE_PERSON' });
    });

    it('is refused when it is too short to be a movement', () => {
      const rushed = performing('turn_left').map((f, i) => ({ ...f, at: i * 10 }));
      expect(judgeEvidence('turn_left', rushed)).toEqual({ ok: false, reason: 'TOO_BRIEF' });
    });

    it('is refused when there are barely any frames', () => {
      expect(judgeEvidence('turn_left', performing('turn_left').slice(0, 4))).toEqual({
        ok: false,
        reason: 'TOO_FEW_FRAMES',
      });
    });

    it('is refused when there is no evidence at all', () => {
      expect(judgeEvidence('turn_left', undefined)).toEqual({ ok: false, reason: 'NO_EVIDENCE' });
      expect(judgeEvidence('turn_left', [])).toEqual({ ok: false, reason: 'TOO_FEW_FRAMES' });
    });
  });

  describe('a blink', () => {
    it('needs the eyes to open again', () => {
      // Eyes shut for the rest of the sequence is a photograph of somebody with
      // their eyes closed, or a bad landmark fit. Neither is a blink.
      const shutForGood = sequence(Array.from({ length: 12 }, (_, i) => ({ eyeOpen: i >= 7 ? 0.05 : 0.3 })));
      expect(judgeEvidence('blink', shutForGood)).toEqual({ ok: false, reason: 'MOVEMENT_NOT_OBSERVED' });
    });

    it('is not satisfied by eyes that merely narrow', () => {
      // Narrowed to just above the fraction of their own open eye that counts
      // as shut. Squinting at a bright lane is not a blink.
      const squint = sequence(Array.from({ length: 12 }, (_, i) => ({ eyeOpen: i === 7 ? 0.3 * L.blinkRatio + 0.02 : 0.3 })));
      expect(judgeEvidence('blink', squint)).toEqual({ ok: false, reason: 'MOVEMENT_NOT_OBSERVED' });
    });
  });

  it('accepts somebody whose resting pose is well off centre', () => {
    /*
     * The bug this whole rule was rewritten for. A camera above and to one side
     * puts a perfectly cooperative person at a resting yaw of 0.3 or more, and
     * the previous version needed a frame within 0.15 of dead centre before any
     * movement counted at all. Nothing they did could finish the challenge: the
     * prompt simply never changed. Every one of these is a real turn, performed
     * from a resting pose that is nowhere near the middle.
     */
    for (const rest of [-0.35, -0.2, 0, 0.25, 0.4]) {
      const turning = sequence(
        Array.from({ length: 12 }, (_, i) => ({ yaw: rest + Math.max(0, (i - 3) / 8) * 0.45 })),
      );
      expect(judgeEvidence('turn_left', turning), `resting at ${rest}`).toEqual({ ok: true });
    }
  });

  it('does not care what order the frames arrive in', () => {
    // They are timestamped, and a client is free to send them out of order.
    // Sorting rather than trusting the array order means a shuffled submission
    // is judged the same way rather than mysteriously failing.
    const inOrder = performing('nod');
    const shuffled = [...inOrder].reverse();
    expect(judgeEvidence('nod', shuffled)).toEqual(judgeEvidence('nod', inOrder));
  });

  it('holds a turn to a real movement, not a twitch', () => {
    const twitch = sequence(Array.from({ length: 12 }, (_, i) => ({ yaw: i >= 6 ? L.turn - 0.05 : 0 })));
    expect(judgeEvidence('turn_left', twitch)).toEqual({ ok: false, reason: 'MOVEMENT_NOT_OBSERVED' });
  });
});
