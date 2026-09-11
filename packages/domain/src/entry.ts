import type { IdentityId, LaneId, TicketId } from './ids.js';
import type { Manifest, ManifestEntry } from './manifest.js';
import { lookupByIdentity } from './manifest.js';
import type { EpochMs } from './time.js';

/**
 * The gate decision. A pure function, because it has to be exercised at exact
 * instants against exact manifest states, and because the scanner runs it with no
 * network — there is nothing to mock and nothing to wait for.
 *
 * Three outcomes, not two. `fallback` is as important as the other two: it is the
 * rung of the degradation ladder that keeps a real human moving when the biometric
 * is uncertain, and a system without it turns a 1.5% false-reject rate into 1.5%
 * of the crowd being told to go home.
 */
export type EntryOutcome = 'admit' | 'deny' | 'fallback';

export type EntryCode =
  | 'MATCHED'
  | 'REENTRY'
  | 'NO_MATCH'
  | 'LOW_CONFIDENCE'
  | 'NOT_IN_MANIFEST'
  | 'CREDENTIAL_REVOKED'
  | 'ALREADY_ADMITTED'
  | 'TOO_EARLY'
  | 'TOO_LATE'
  | 'WRONG_GATE'
  | 'MANIFEST_EXPIRED'
  // The face matched, and the lane could not satisfy itself that it was a face
  // rather than a picture of one. Always a fallback, never a denial: the desk
  // exists to tell an attack apart from a camera that could not see, and a lane
  // cannot.
  | 'LIVENESS_FAILED';

export interface EntryDecision {
  readonly outcome: EntryOutcome;
  readonly code: EntryCode;
  /** Shown on the scanner, read aloud by a steward. Short, and never accusatory. */
  readonly operatorMessage: string;
  readonly ticketId?: TicketId;
  readonly identityId?: IdentityId;
}

export interface MatchResult {
  readonly matched: boolean;
  readonly identityId?: IdentityId;
  /** Similarity in [0, 1]. Compared against the lane's configured threshold. */
  readonly score: number;
}

export interface EntryInput {
  readonly manifest: Manifest;
  readonly match: MatchResult;
  readonly now: EpochMs;
  readonly lane: LaneId;
  readonly gateGroup: string;
  /** Above this, admit. Below `reviewThreshold`, treat as no match. */
  readonly matchThreshold: number;
  /** Between the two thresholds, send to the resolution lane rather than guessing. */
  readonly reviewThreshold: number;
  /** Ticket ids already admitted at this event, across all lanes, as far as this scanner knows. */
  readonly admitted: ReadonlySet<TicketId>;
  readonly allowReentry: boolean;
}

export function decideEntry(input: EntryInput): EntryDecision {
  const { manifest, match, now } = input;

  if (now >= manifest.expiresAt) {
    return {
      outcome: 'fallback',
      code: 'MANIFEST_EXPIRED',
      operatorMessage: 'This scanner needs re-keying. Send to the resolution desk.',
    };
  }

  if (!match.matched || match.identityId === undefined || match.score < input.reviewThreshold) {
    return {
      outcome: 'fallback',
      code: 'NO_MATCH',
      operatorMessage: 'No match. Try once more, then send to the resolution desk.',
    };
  }

  if (match.score < input.matchThreshold) {
    return {
      outcome: 'fallback',
      code: 'LOW_CONFIDENCE',
      operatorMessage: 'Close, not certain. Ask them to look straight at the camera and try again.',
      identityId: match.identityId,
    };
  }

  const entry: ManifestEntry | undefined = lookupByIdentity(manifest, match.identityId);
  if (entry === undefined) {
    return {
      outcome: 'deny',
      code: 'NOT_IN_MANIFEST',
      operatorMessage: 'No ticket for this person at this event.',
      identityId: match.identityId,
    };
  }

  if (entry.revoked) {
    return {
      outcome: 'deny',
      code: 'CREDENTIAL_REVOKED',
      operatorMessage: 'This ticket was resold or cancelled. It belongs to somebody else now.',
      ticketId: entry.ticketId,
      identityId: entry.identityId,
    };
  }

  if (entry.gates.length > 0 && !entry.gates.includes(input.gateGroup)) {
    return {
      outcome: 'deny',
      code: 'WRONG_GATE',
      operatorMessage: `Valid ticket, wrong entrance. Direct them to ${entry.gates.join(' or ')}.`,
      ticketId: entry.ticketId,
      identityId: entry.identityId,
    };
  }

  if (now < entry.admitFrom) {
    return {
      outcome: 'deny',
      code: 'TOO_EARLY',
      operatorMessage: 'Doors have not opened for this ticket type yet.',
      ticketId: entry.ticketId,
      identityId: entry.identityId,
    };
  }

  if (now >= entry.admitUntil) {
    return {
      outcome: 'deny',
      code: 'TOO_LATE',
      operatorMessage: 'Entry for this ticket has closed.',
      ticketId: entry.ticketId,
      identityId: entry.identityId,
    };
  }

  if (input.admitted.has(entry.ticketId)) {
    if (input.allowReentry) {
      return {
        outcome: 'admit',
        code: 'REENTRY',
        operatorMessage: 'Welcome back.',
        ticketId: entry.ticketId,
        identityId: entry.identityId,
      };
    }
    return {
      outcome: 'deny',
      code: 'ALREADY_ADMITTED',
      operatorMessage: 'This ticket has already been used to enter.',
      ticketId: entry.ticketId,
      identityId: entry.identityId,
    };
  }

  return {
    outcome: 'admit',
    code: 'MATCHED',
    operatorMessage: 'Welcome in.',
    ticketId: entry.ticketId,
    identityId: entry.identityId,
  };
}

/**
 * A signed record of what a lane decided, queued locally and uploaded when the
 * network comes back. Reconciliation over these is how a double-entry during a
 * partition gets detected — see architecture §06.
 */
export interface EntryAttestation {
  readonly ticketId: TicketId;
  readonly identityId: IdentityId;
  readonly lane: LaneId;
  readonly decidedAt: EpochMs;
  readonly outcome: EntryOutcome;
  readonly code: EntryCode;
  readonly matchScore: number;
  /** Manifest sequence the lane was on. Tells reconciliation how stale the decision was. */
  readonly manifestSequence: number;
  readonly offline: boolean;
}

export interface DoubleEntry {
  readonly ticketId: TicketId;
  readonly attestations: readonly EntryAttestation[];
}

/**
 * Find tickets admitted more than once. Expected to return nothing; when it does
 * return something, at least one of the lanes was offline, and that is the whole
 * point of recording `offline` and `manifestSequence` on every attestation.
 */
export function findDoubleEntries(attestations: readonly EntryAttestation[]): readonly DoubleEntry[] {
  const byTicket = new Map<TicketId, EntryAttestation[]>();
  for (const a of attestations) {
    if (a.outcome !== 'admit' || a.code === 'REENTRY') continue;
    const list = byTicket.get(a.ticketId);
    if (list) list.push(a);
    else byTicket.set(a.ticketId, [a]);
  }

  const result: DoubleEntry[] = [];
  for (const [ticketId, list] of byTicket) {
    if (list.length > 1) {
      result.push({
        ticketId,
        attestations: [...list].sort((a, b) => a.decidedAt - b.decidedAt),
      });
    }
  }
  return result;
}
