import { PROTOTYPE_THRESHOLDS, similarity } from '@rexell/biometrics';
import type { FaceVector, Thresholds } from '@rexell/biometrics';
import { identityId as toIdentityId, ticketId as toTicketId } from '@rexell/domain';
import type { Delta, EntryCode, EntryDecision, EntryOutcome } from '@rexell/domain';
import type { GateEntry, GateManifest } from './manifest.js';
import { AttestationQueue, canonicalAttestation, signAttestation } from './attestation.js';
import type { Attestation } from './attestation.js';
import type { SignedAttestation } from './attestation.js';

/**
 * The scanner engine.
 *
 * Everything here runs on the device with no network. That is not an
 * optimisation — venue cellular collapses under crowd load at exactly the moment
 * the gate needs it, so an online-only gate is a gate that stops working when
 * nine thousand people arrive.
 *
 * The consequence is that this class holds the authority to admit somebody, and
 * every design choice below follows from taking that seriously:
 *
 *   - It never denies on a failed match. Uncertainty routes to a staffed lane.
 *   - It applies deltas strictly in sequence and stops at a gap rather than
 *     guessing, because the missing delta might be the revocation.
 *   - It signs every decision, including the ones it got wrong, so the night can
 *     be reconstructed afterwards.
 */

export interface GateConfig {
  readonly scannerId: string;
  readonly lane: string;
  readonly gateGroup: string;
  /** Omit when signing is deferred — see `unsignedPending`. */
  readonly privateKeyPem?: string;
  readonly allowReentry: boolean;
  readonly thresholds?: Thresholds;
  /** Warn the operator once this far behind the server's sequence. */
  readonly warnBehindBy?: number;
}

export interface ScanResult {
  readonly decision: EntryDecision;
  readonly attestation: SignedAttestation;
  /** Wall-clock time spent in `scan`, for the latency budget. */
  readonly elapsedMs: number;
  /** How many credentials were compared. The 1:N cost, made visible. */
  readonly compared: number;
}

export interface GateStatus {
  readonly sequence: number;
  readonly behindBy: number;
  readonly credentials: number;
  readonly admitted: number;
  readonly pendingUploads: number;
  readonly droppedUploads: number;
  readonly expired: boolean;
  readonly warn: boolean;
  readonly online: boolean;
}

export class GateEngine {
  #manifest: GateManifest;
  #byIdentity: Map<string, GateEntry>;
  #admitted = new Set<string>();
  #queue = new AttestationQueue();
  #serverSequence: number;
  #online = false;
  #gapDeferred: Delta[] = [];
  #unsigned: Array<{ attestation: SignedAttestation; message: string }> = [];

  constructor(
    manifest: GateManifest,
    private readonly config: GateConfig,
  ) {
    this.#manifest = manifest;
    this.#byIdentity = new Map(manifest.entries.map((e) => [e.identityId, e]));
    this.#serverSequence = manifest.sequence;
  }

  get thresholds(): Thresholds {
    return this.config.thresholds ?? PROTOTYPE_THRESHOLDS;
  }

  setOnline(online: boolean): void {
    this.#online = online;
  }

  /**
   * Scan a face.
   *
   * The whole decision, start to finish, with no I/O. The order is chosen so the
   * expensive step — comparing against every credential in the gallery — happens
   * only after the cheap disqualifiers.
   */
  scan(probe: FaceVector, now: number): ScanResult {
    const started = performance.now();

    let decision: EntryDecision;
    let compared = 0;
    let bestScore = 0;

    if (now >= this.#manifest.expiresAt) {
      decision = {
        outcome: 'fallback',
        code: 'MANIFEST_EXPIRED',
        operatorMessage: 'This scanner needs re-keying. Send to the resolution desk.',
      };
    } else {
      // 1:N against a bounded gallery. Twelve thousand faces, not twelve million
      // — which is exactly why scoping the manifest to one event makes this
      // tractable inside the latency budget.
      let best: GateEntry | undefined;
      for (const entry of this.#manifest.entries) {
        compared += 1;
        const score = similarity(probe, entry.template);
        if (score > bestScore) {
          bestScore = score;
          best = entry;
        }
      }
      decision = this.#decide(best, bestScore, now);
    }

    const elapsedMs = performance.now() - started;

    const record: Attestation = {
      ticketId: decision.ticketId ?? 'unknown',
      identityId: decision.identityId ?? 'unknown',
      eventId: this.#manifest.eventId,
      lane: this.config.lane,
      decidedAt: now,
      outcome: decision.outcome,
      code: decision.code,
      matchScore: bestScore,
      manifestSequence: this.#manifest.sequence,
      offline: !this.#online,
    };

    let attestation: SignedAttestation;
    if (this.config.privateKeyPem) {
      attestation = signAttestation(record, this.config.scannerId, this.config.privateKeyPem);
      this.#queue.add(attestation);
    } else {
      // Deferred signing. The record is held with an empty signature and the
      // canonical bytes it will be signed over, so a browser can fill them in
      // with WebCrypto before upload without an async hop on the scan path.
      attestation = { ...record, scannerId: this.config.scannerId, signature: '' };
      this.#unsigned.push({ attestation, message: canonicalAttestation(record, this.config.scannerId) });
    }

    if (decision.outcome === 'admit' && decision.ticketId) {
      this.#admitted.add(decision.ticketId);
    }

    return { decision, attestation, elapsedMs, compared };
  }

  #decide(best: GateEntry | undefined, score: number, now: number): EntryDecision {
    const t = this.thresholds;

    if (!best || score < t.review) {
      // Never a denial. A false reject that sends somebody home turns a 1.5%
      // error rate into 1.5% of the crowd being refused entry they paid for.
      return {
        outcome: 'fallback',
        code: 'NO_MATCH',
        operatorMessage: 'No match. Try once more, then send to the resolution desk.',
      };
    }

    if (score < t.match) {
      return {
        outcome: 'fallback',
        code: 'LOW_CONFIDENCE',
        operatorMessage: 'Close, not certain. Ask them to look straight at the camera and try again.',
        identityId: toIdentityId(best.identityId),
      };
    }

    // The manifest speaks in plain strings because it crosses a wire; the domain
    // speaks in branded ids. This is the boundary where that converts.
    const base = { ticketId: toTicketId(best.ticketId), identityId: toIdentityId(best.identityId) };

    if (best.revoked) {
      return {
        outcome: 'deny',
        code: 'CREDENTIAL_REVOKED',
        operatorMessage: 'This ticket was resold or cancelled. It belongs to somebody else now.',
        ...base,
      };
    }
    if (best.gates.length > 0 && !best.gates.includes(this.config.gateGroup)) {
      return {
        outcome: 'deny',
        code: 'WRONG_GATE',
        operatorMessage: `Valid ticket, wrong entrance. Direct them to ${best.gates.join(' or ')}.`,
        ...base,
      };
    }
    if (now < best.admitFrom) {
      return { outcome: 'deny', code: 'TOO_EARLY', operatorMessage: 'Doors have not opened for this ticket type yet.', ...base };
    }
    if (now >= best.admitUntil) {
      return { outcome: 'deny', code: 'TOO_LATE', operatorMessage: 'Entry for this ticket has closed.', ...base };
    }
    if (this.#admitted.has(best.ticketId)) {
      return this.config.allowReentry
        ? { outcome: 'admit', code: 'REENTRY', operatorMessage: 'Welcome back.', ...base }
        : { outcome: 'deny', code: 'ALREADY_ADMITTED', operatorMessage: 'This ticket has already been used to enter.', ...base };
    }

    return { outcome: 'admit', code: 'MATCHED', operatorMessage: 'Welcome in.', ...base };
  }

  /**
   * Apply a batch of deltas.
   *
   * Stops at the first gap. Applying delta 7 without 6 could admit somebody whose
   * credential 6 revoked, so the engine holds the remainder and tells the
   * operator it is behind rather than guessing.
   */
  applyDeltas(deltas: readonly Delta[]): { applied: number; gapDetected: boolean; deferred: number } {
    const ordered = [...this.#gapDeferred, ...deltas].sort((a, b) => a.seq - b.seq);
    this.#gapDeferred = [];

    let sequence = this.#manifest.sequence;
    let applied = 0;
    let gapDetected = false;
    const entries = [...this.#manifest.entries];

    for (const delta of ordered) {
      if (delta.seq <= sequence) continue; // already applied, or a duplicate delivery
      if (gapDetected || delta.seq !== sequence + 1) {
        gapDetected = true;
        this.#gapDeferred.push(delta);
        continue;
      }

      const index = 'ticketId' in delta ? entries.findIndex((e) => e.ticketId === delta.ticketId) : -1;

      if (delta.kind === 'revoke' && index >= 0) {
        entries[index] = { ...entries[index]!, revoked: true };
      } else if (delta.kind === 'rebind' && index >= 0) {
        // A rebind without a new template is a revocation from this lane's point
        // of view: the ticket is somebody else's, and this scanner cannot match
        // that somebody until the next full manifest. Denying the seller is the
        // half that matters — admitting the buyer can wait for a re-key.
        entries[index] = { ...entries[index]!, identityId: delta.identityId, revoked: true };
      }
      // `add` deltas carry no template either, for the same reason. A late sale
      // is admitted through the resolution desk until the next manifest.

      sequence = delta.seq;
      applied += 1;
    }

    this.#manifest = { ...this.#manifest, sequence, entries };
    this.#byIdentity = new Map(entries.map((e) => [e.identityId, e]));
    if (sequence > this.#serverSequence) this.#serverSequence = sequence;

    return { applied, gapDetected, deferred: this.#gapDeferred.length };
  }

  noteServerSequence(sequence: number): void {
    this.#serverSequence = Math.max(this.#serverSequence, sequence);
  }

  status(now: number): GateStatus {
    const behindBy = Math.max(0, this.#serverSequence - this.#manifest.sequence);
    return {
      sequence: this.#manifest.sequence,
      behindBy,
      credentials: this.#manifest.entries.length,
      admitted: this.#admitted.size,
      pendingUploads: this.#queue.pending + this.#unsigned.length,
      droppedUploads: this.#queue.dropped,
      expired: now >= this.#manifest.expiresAt,
      warn: behindBy >= (this.config.warnBehindBy ?? 1),
      online: this.#online,
    };
  }

  /** Records awaiting a signature, with the exact bytes to sign. */
  unsignedPending(): ReadonlyArray<{ attestation: SignedAttestation; message: string }> {
    return this.#unsigned;
  }

  /** Attach signatures produced elsewhere and move the records into the queue. */
  attachSignatures(signatures: readonly string[]): number {
    const taken = this.#unsigned.splice(0, signatures.length);
    taken.forEach((item, i) => {
      this.#queue.add({ ...item.attestation, signature: signatures[i] ?? '' });
    });
    return taken.length;
  }

  pendingUploads(limit?: number): readonly SignedAttestation[] {
    return this.#queue.peek(limit);
  }

  acknowledgeUploads(count: number): void {
    this.#queue.acknowledge(count);
  }

  /**
   * Cryptographic erasure at TTL.
   *
   * Drops every template from memory and reports what it destroyed, so the
   * deletion can be audited per device rather than assumed.
   */
  erase(): { erased: number; eventId: string } {
    const erased = this.#manifest.entries.length;
    for (const entry of this.#manifest.entries) {
      (entry.template as Float32Array).fill(0);
    }
    this.#manifest = { ...this.#manifest, entries: [] };
    this.#byIdentity.clear();
    return { erased, eventId: this.#manifest.eventId };
  }

  /** Test and diagnostic access. Never used on the decision path. */
  lookup(identityId: string): GateEntry | undefined {
    return this.#byIdentity.get(identityId);
  }
}

export type { EntryOutcome, EntryCode };
