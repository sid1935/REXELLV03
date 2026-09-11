/**
 * The gate, end to end, on faces.
 *
 * Everything else in this package is tested with synthetic vectors, which prove
 * the manifest seals, the deltas apply in order and the attestations sign. They
 * cannot prove the only thing a person standing at a door cares about: that the
 * lane lets them in and does not let somebody else in.
 *
 * So this builds a real event. Five people hold tickets, each enrolled from one
 * photograph. The manifest is sealed and reopened through the real wire format.
 * Then each of them walks up to the camera — represented by a DIFFERENT
 * photograph, taken in a different year by a different photographer — and the
 * engine decides. Strangers with no ticket walk up too.
 *
 * The descriptors come from `@rexell/biometrics/test/real-faces.json`, produced
 * by the browser matcher from Creative Commons photographs. No camera, no
 * weights, no browser: 128 numbers per face, which is all the gate ever gets.
 */
import { describe, expect, it } from 'vitest';
import { toFaceVector } from '@rexell/biometrics';
import type { FaceVector } from '@rexell/biometrics';
import faces from '../../biometrics/test/real-faces.json' with { type: 'json' };
import type { GateEntry } from '../src/index.js';
import { generateDeviceKey, verifyAttestation } from '../src/index.js';
import { DOORS, EVENT, EXPIRY, SCANNER, engine, entry, roundTrip } from './helpers.js';

interface Face {
  person: string;
  photo: string;
  title: string;
  vector: number[];
}

const all = (faces as Face[]).map((f) => ({ ...f, v: toFaceVector(f.vector) }));
const people = [...new Set(all.map((f) => f.person))];
const photosOf = (person: string) => all.filter((f) => f.person === person);

/**
 * One ticket per person, enrolled from their first photograph.
 *
 * The rest of that person's photographs are what they turn up with — the whole
 * point being that the gate never sees the enrolled image again.
 */
const ticketHolders = people.filter((p) => photosOf(p).length >= 2);
const enrolled = new Map(ticketHolders.map((p) => [p, photosOf(p)[0]!]));

function realManifest() {
  return {
    eventId: EVENT,
    scannerId: SCANNER,
    sequence: 0,
    generatedAt: DOORS - 7_200_000,
    expiresAt: EXPIRY,
    entries: ticketHolders.map((person, i) =>
      entry(i, {
        ticketId: `tkt_${person}`,
        identityId: `idn_${person}`,
        template: enrolled.get(person)!.v as FaceVector,
      }),
    ) as GateEntry[],
  };
}

describe('the gate, on real faces', () => {
  it('has enough people to be a 1:N decision at all', () => {
    expect(ticketHolders.length).toBeGreaterThanOrEqual(4);
  });

  it('admits every ticket-holder from a photograph it has never seen', () => {
    const results: string[] = [];
    for (const person of ticketHolders) {
      for (const photo of photosOf(person).slice(1)) {
        // A fresh lane per photograph. Reusing one turns the second arrival
        // into ALREADY_ADMITTED — correct behaviour, and it would hide whether
        // the second photograph was recognised at all.
        const g = engine(roundTrip(realManifest()));
        const d = g.scan(photo.v as FaceVector, DOORS).decision;
        if (d.outcome !== 'admit' || d.ticketId !== `tkt_${person}`) {
          results.push(`${photo.photo}: ${d.outcome} ${d.code}`);
        }
      }
    }
    expect(results, 'these ticket-holders were not admitted on their own ticket').toEqual([]);
  });

  it('never admits somebody without a ticket', () => {
    // Everybody is a stranger here: the manifest holds one person's ticket and
    // every other photograph in the fixture walks up to it.
    const admitted: string[] = [];
    for (const holder of ticketHolders) {
      const g = engine(
        roundTrip({
          ...realManifest(),
          entries: [entry(0, { ticketId: `tkt_${holder}`, identityId: `idn_${holder}`, template: enrolled.get(holder)!.v as FaceVector })],
        }),
      );
      for (const photo of all.filter((f) => f.person !== holder)) {
        const d = g.scan(photo.v as FaceVector, DOORS).decision;
        if (d.outcome === 'admit') admitted.push(`${photo.photo} got in on ${holder}'s ticket`);
      }
    }
    expect(admitted).toEqual([]);
  });

  it('refuses a resold ticket to the person who sold it', () => {
    // The revocation that makes resale safe. The seller's face is still the
    // best match in the manifest — it has to be, or this would prove nothing —
    // and the entry is marked revoked, so the right answer is a denial rather
    // than a shrug.
    const [seller] = ticketHolders;
    const g = engine(
      roundTrip({
        ...realManifest(),
        entries: [
          entry(0, {
            ticketId: `tkt_${seller}`,
            identityId: `idn_${seller}`,
            template: enrolled.get(seller!)!.v as FaceVector,
            revoked: true,
          }),
        ],
      }),
    );
    const d = g.scan(photosOf(seller!)[1]!.v as FaceVector, DOORS).decision;
    expect(d.outcome).toBe('deny');
    expect(d.code).toBe('CREDENTIAL_REVOKED');
  });

  it('refuses the same face a second time on one ticket', () => {
    const [person] = ticketHolders;
    const photos = photosOf(person!);
    const g = engine(roundTrip(realManifest()));

    expect(g.scan(photos[1]!.v as FaceVector, DOORS).decision.outcome).toBe('admit');
    // A third photograph of the same person, which is a different vector — so
    // this is caught by having recognised them, not by having seen these exact
    // numbers before.
    const second = photos[2] ?? photos[1]!;
    expect(g.scan(second.v as FaceVector, DOORS + 60_000).decision.code).toBe('ALREADY_ADMITTED');
  });
});

/**
 * Liveness at the lane.
 *
 * The lane reaches its own verdict — it picks the movement and judges the
 * answer, because unlike the phone at signup the device belongs to the venue.
 * What is tested here is what the engine does with that verdict, and the three
 * things that matter are the order it is checked in, the outcome it produces,
 * and that it cannot be edited out of the signed record afterwards.
 */
describe('liveness at the gate', () => {
  const holder = ticketHolders[0]!;
  const lane = () => engine(roundTrip(realManifest()));
  const probe = () => photosOf(holder)[1]!.v as FaceVector;
  const live = { kind: 'turn_left', passed: true, frames: 9 };
  const dead = { kind: 'turn_left', passed: false, frames: 9 };

  it('admits a ticket-holder who moved', () => {
    const d = lane().scan(probe(), DOORS, live).decision;
    expect(d.outcome).toBe('admit');
    expect(d.code).toBe('MATCHED');
  });

  it('sends a matching face that did not move to the desk, and does not deny it', () => {
    // A photograph of a ticket-holder. It is the right face, so the matcher is
    // satisfied and only this check is not — and a denial here would refuse
    // real people in bad light, so it is a referral.
    const d = lane().scan(probe(), DOORS, dead).decision;
    expect(d.outcome).toBe('fallback');
    expect(d.code).toBe('LIVENESS_FAILED');
  });

  it('does not admit the ticket when liveness failed', () => {
    // The admission set must not learn about somebody who never got in, or
    // their real arrival a minute later reads as a second entry.
    const g = lane();
    g.scan(probe(), DOORS, dead);
    expect(g.status(DOORS).admitted).toBe(0);
    expect(g.scan(probe(), DOORS + 60_000, live).decision.outcome).toBe('admit');
  });

  it('tells a stranger nothing about liveness', () => {
    // Ordering, and it is a disclosure question rather than a style one. A
    // stranger who is told their liveness failed has been told the face WAS
    // recognised, which is a fact about the ticket-holder.
    // A manifest holding one ticket, so everybody else really is a stranger.
    // Picking any other face out of the full five-person manifest does not
    // test this: they have a ticket of their own, so matching and then failing
    // liveness is the right answer for them.
    const g = engine(
      roundTrip({
        ...realManifest(),
        entries: [entry(0, { ticketId: `tkt_${holder}`, identityId: `idn_${holder}`, template: enrolled.get(holder)!.v as FaceVector })],
      }),
    );
    const stranger = all.find((f) => f.person !== holder)!.v as FaceVector;
    const d = g.scan(stranger, DOORS, dead).decision;
    expect(d.code).toBe('NO_MATCH');
  });

  it('runs without a verdict at all, for a lane with the check turned off', () => {
    const d = lane().scan(probe(), DOORS).decision;
    expect(d.outcome).toBe('admit');
  });

  it('signs the verdict, so it cannot be edited afterwards', () => {
    const keys = generateDeviceKey();
    const g = engine(roundTrip(realManifest()), { privateKeyPem: keys.privateKeyPem });
    const { attestation } = g.scan(probe(), DOORS, live);

    expect(attestation.liveness).toEqual(live);
    expect(verifyAttestation(attestation, keys.publicKeyPem)).toBe(true);

    // The three edits somebody would actually make: turn a failure into a pass,
    // and erase the fact that the lane ever checked.
    expect(verifyAttestation({ ...attestation, liveness: dead }, keys.publicKeyPem)).toBe(false);
    const { liveness: _dropped, ...stripped } = attestation;
    expect(verifyAttestation(stripped, keys.publicKeyPem)).toBe(false);
    expect(
      verifyAttestation({ ...attestation, liveness: { ...live, frames: 99 } }, keys.publicKeyPem),
    ).toBe(false);
  });
});
