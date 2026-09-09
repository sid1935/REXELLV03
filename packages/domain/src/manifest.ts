import type { EventId, IdentityId, TemplateRef, TicketId, TierId } from './ids.js';
import type { EpochMs } from './time.js';

/**
 * The event manifest is the whole reason the gate can work offline.
 *
 * It is a bounded set — twelve thousand faces, not twelve million — which is what
 * makes an on-device 1:N search tractable inside the latency budget. It is scoped
 * to one event, keyed at doors-open, and destroyed on a TTL, so a scanner stolen
 * from a venue yields one night's ticket-holders and nothing else.
 */
export interface ManifestEntry {
  readonly ticketId: TicketId;
  readonly identityId: IdentityId;
  readonly tierId: TierId;
  /** Sealed template. The scanner can match against it; nothing can read it back out. */
  readonly templateRef: TemplateRef;
  readonly seat?: string;
  /** Gate groups this credential opens. Empty means every gate. */
  readonly gates: readonly string[];
  readonly admitFrom: EpochMs;
  readonly admitUntil: EpochMs;
  readonly revoked: boolean;
}

export interface Manifest {
  readonly eventId: EventId;
  /** Monotonic. A scanner compares this to the server's latest to know how stale it is. */
  readonly sequence: number;
  readonly generatedAt: EpochMs;
  /** After this the scanner cryptographically erases the manifest and reports it. */
  readonly expiresAt: EpochMs;
  readonly entries: ReadonlyMap<TicketId, ManifestEntry>;
}

export type Delta =
  | { readonly seq: number; readonly kind: 'add'; readonly entry: ManifestEntry }
  /** A resale happened. The seller's face must stop working at every lane. */
  | { readonly seq: number; readonly kind: 'rebind'; readonly ticketId: TicketId; readonly identityId: IdentityId; readonly templateRef: TemplateRef }
  | { readonly seq: number; readonly kind: 'revoke'; readonly ticketId: TicketId; readonly reason: string };

export interface ApplyResult {
  readonly manifest: Manifest;
  readonly applied: number;
  /** Deltas we could not apply because an earlier one is missing. */
  readonly deferred: readonly Delta[];
  /** True when there is a hole in the sequence. The operator is shown this. */
  readonly gapDetected: boolean;
}

export function emptyManifest(eventId: EventId, generatedAt: EpochMs, expiresAt: EpochMs): Manifest {
  return { eventId, sequence: 0, generatedAt, expiresAt, entries: new Map() };
}

/**
 * Apply an ordered batch of deltas.
 *
 * Rules, all of which exist because scanners go offline and come back in an
 * arbitrary order:
 *
 *  - Deltas are sorted and de-duplicated by sequence number, so a re-delivered
 *    batch is harmless. Applying the same delta twice must not corrupt anything.
 *  - Anything at or below the current sequence is already applied and skipped.
 *  - The first gap stops application. Applying delta 7 without delta 6 could mean
 *    admitting somebody whose credential was revoked in 6, so we stop and say so
 *    rather than guessing.
 */
export function applyDeltas(manifest: Manifest, deltas: readonly Delta[]): ApplyResult {
  const ordered = [...deltas].sort((a, b) => a.seq - b.seq);
  const entries = new Map(manifest.entries);

  let sequence = manifest.sequence;
  let applied = 0;
  let gapDetected = false;
  const deferred: Delta[] = [];

  for (const delta of ordered) {
    if (delta.seq <= sequence) continue; // already applied, or a duplicate delivery
    if (gapDetected || delta.seq !== sequence + 1) {
      gapDetected = true;
      deferred.push(delta);
      continue;
    }

    switch (delta.kind) {
      case 'add':
        entries.set(delta.entry.ticketId, delta.entry);
        break;
      case 'rebind': {
        const existing = entries.get(delta.ticketId);
        if (existing) {
          entries.set(delta.ticketId, {
            ...existing,
            identityId: delta.identityId,
            templateRef: delta.templateRef,
          });
        }
        break;
      }
      case 'revoke': {
        const existing = entries.get(delta.ticketId);
        if (existing) {
          entries.set(delta.ticketId, { ...existing, revoked: true });
        }
        break;
      }
    }

    sequence = delta.seq;
    applied += 1;
  }

  return {
    manifest: { ...manifest, sequence, entries },
    applied,
    deferred,
    gapDetected,
  };
}

export interface Staleness {
  readonly behindBy: number;
  readonly ageMs: number;
  readonly expired: boolean;
  /**
   * Whether the operator should be shown a warning. A scanner that is a few
   * seconds behind is normal; one that is minutes behind during a resale window
   * is admitting people on stale credentials.
   */
  readonly warn: boolean;
}

export function manifestStaleness(
  manifest: Manifest,
  serverSequence: number,
  now: EpochMs,
  warnBehindBy = 1,
): Staleness {
  const behindBy = Math.max(0, serverSequence - manifest.sequence);
  return {
    behindBy,
    ageMs: Math.max(0, now - manifest.generatedAt),
    expired: now >= manifest.expiresAt,
    warn: behindBy >= warnBehindBy,
  };
}

/** Find the credential a match resolved to. Returns undefined rather than throwing. */
export function lookupByIdentity(manifest: Manifest, identity: IdentityId): ManifestEntry | undefined {
  for (const entry of manifest.entries.values()) {
    if (entry.identityId === identity) return entry;
  }
  return undefined;
}
