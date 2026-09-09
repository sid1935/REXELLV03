import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FaceVector, ModelVersion, SealedTemplate, Thresholds } from '@rexell/biometrics';
import { PROTOTYPE_THRESHOLDS, fromRow, seal, similarity, unseal } from '@rexell/biometrics';
import { deriveManifestKey, sealManifest } from '@rexell/gate';
import type { GateCredential, GateEntry, GateManifest, SealedManifest } from '@rexell/gate';

/**
 * The vault's own database.
 *
 * Separate file, separate process, separate key material. Nothing in
 * `packages/db` can reach it and nothing here imports `packages/db`. That
 * separation is the entire security property of this service, so it is enforced
 * by there being no dependency edge at all rather than by a convention.
 *
 * Note what is NOT stored here: no name, no contact, no ticket, no order. The
 * vault knows opaque identity handles and sealed bytes. Someone who steals this
 * database learns that some pseudonyms have faces, and nothing else.
 */
const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS templates (
  template_ref   TEXT PRIMARY KEY,
  identity_id    TEXT NOT NULL,
  scope          TEXT NOT NULL,
  ciphertext     BLOB NOT NULL,
  iv             BLOB NOT NULL,
  tag            BLOB NOT NULL,
  wrapped_key    BLOB NOT NULL,
  wrap_iv        BLOB NOT NULL,
  wrap_tag       BLOB NOT NULL,
  model_version  TEXT NOT NULL,
  enrolled_at    INTEGER NOT NULL,
  consent_id     TEXT NOT NULL
);
-- One live template per identity per scope. Re-enrolling replaces.
CREATE UNIQUE INDEX IF NOT EXISTS templates_identity_scope ON templates(identity_id, scope);
CREATE INDEX IF NOT EXISTS templates_scope ON templates(scope);

-- Flags, not blocks. Twins and siblings exist, and a biometric that cannot be
-- appealed is a liability rather than a feature.
CREATE TABLE IF NOT EXISTS dedupe_flags (
  flag_id       TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  identity_id   TEXT NOT NULL,
  matched_id    TEXT NOT NULL,
  score         REAL NOT NULL,
  raised_at     INTEGER NOT NULL,
  resolved_at   INTEGER,
  resolution    TEXT
);
CREATE INDEX IF NOT EXISTS dedupe_open ON dedupe_flags(resolved_at, scope);

-- Kept after the template is gone. Proving a deletion happened requires a record
-- that outlives the thing deleted.
CREATE TABLE IF NOT EXISTS deletion_receipts (
  receipt_id     TEXT PRIMARY KEY,
  identity_id    TEXT NOT NULL,
  deleted_count  INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  deleted_at     INTEGER NOT NULL,
  digest         TEXT NOT NULL
);

-- Manifest issuance and key release, tracked separately.
--
-- Sealing a manifest and releasing its key are two acts on two channels. The
-- blob can be distributed days early; the key is refused outside its window.
-- Recording both is how a support engineer answers "which device could open
-- which night" after an incident.
CREATE TABLE IF NOT EXISTS manifests (
  manifest_id      TEXT PRIMARY KEY,
  scanner_id       TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  scope            TEXT NOT NULL,
  credential_count INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  release_from     INTEGER NOT NULL,
  sealed_at        INTEGER NOT NULL,
  key_released_at  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS manifests_device_event ON manifests(scanner_id, event_id, expires_at);

-- Every operation touching a template, whether or not it succeeded.
CREATE TABLE IF NOT EXISTS access_log (
  entry_id     TEXT PRIMARY KEY,
  operation    TEXT NOT NULL,
  identity_id  TEXT,
  scope        TEXT,
  outcome      TEXT NOT NULL,
  at           INTEGER NOT NULL
);
`;

export interface DeletionReceipt {
  readonly receiptId: string;
  readonly identityId: string;
  readonly deletedCount: number;
  readonly reason: string;
  readonly deletedAt: number;
  /** HMAC over the fields above, under a key only the vault holds. */
  readonly digest: string;
}

export interface DedupeMatch {
  readonly identityId: string;
  readonly score: number;
}

export interface EnrolResult {
  readonly templateRef: string;
  readonly replaced: boolean;
  readonly dedupe: { readonly status: 'clear' | 'review'; readonly matches: readonly DedupeMatch[] };
}

export interface IdentifyResult {
  readonly matched: boolean;
  readonly identityId?: string;
  readonly score: number;
}

export class VaultStore {
  readonly #db: DatabaseSync;
  readonly #masterKey: Buffer;
  readonly #receiptKey: Buffer;
  readonly #manifestKey: Buffer;
  readonly #thresholds: Thresholds;

  constructor(opts: {
    location?: string;
    masterKey: Buffer;
    receiptKey: Buffer;
    /** Root of the per-(scanner, event, expiry) manifest key derivation. */
    manifestKey?: Buffer;
    thresholds?: Thresholds;
  }) {
    this.#db = new DatabaseSync(opts.location ?? ':memory:');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(SCHEMA);
    this.#masterKey = opts.masterKey;
    this.#receiptKey = opts.receiptKey;
    this.#manifestKey = opts.manifestKey ?? opts.masterKey;
    this.#thresholds = opts.thresholds ?? PROTOTYPE_THRESHOLDS;
  }

  #log(operation: string, outcome: string, at: number, identityId?: string, scope?: string): void {
    this.#db
      .prepare('INSERT INTO access_log (entry_id, operation, identity_id, scope, outcome, at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), operation, identityId ?? null, scope ?? null, outcome, at);
  }

  /** Load and unseal every template in a scope. Private, and it never leaves this class. */
  #galleryFor(scope: string): Array<{ identityId: string; vector: FaceVector; modelVersion: string }> {
    const rows = this.#db.prepare('SELECT * FROM templates WHERE scope = ?').all(scope) as Array<
      Record<string, never>
    >;
    const gallery: Array<{ identityId: string; vector: FaceVector; modelVersion: string }> = [];
    for (const row of rows) {
      const r = row as unknown as {
        identity_id: string;
        model_version: string;
        ciphertext: Uint8Array;
        iv: Uint8Array;
        tag: Uint8Array;
        wrapped_key: Uint8Array;
        wrap_iv: Uint8Array;
        wrap_tag: Uint8Array;
      };
      const sealed: SealedTemplate = fromRow({
        ciphertext: r.ciphertext,
        iv: r.iv,
        tag: r.tag,
        wrapped_key: r.wrapped_key,
        wrap_iv: r.wrap_iv,
        wrap_tag: r.wrap_tag,
        model_version: r.model_version,
      });
      gallery.push({
        identityId: r.identity_id,
        vector: unseal(sealed, this.#masterKey),
        modelVersion: r.model_version,
      });
    }
    return gallery;
  }

  /**
   * Enrol, and check the scope for the same face on another account.
   *
   * The dedupe pass is why an onsale purchase limit means anything: without it,
   * one person opens sixty accounts and the per-identity cap becomes a per-email
   * cap. It flags rather than blocks — see the twin problem in architecture §03.
   */
  enrol(input: {
    identityId: string;
    scope: string;
    vector: FaceVector;
    modelVersion: ModelVersion;
    consentId: string;
    now: number;
  }): EnrolResult {
    const { identityId, scope, vector, modelVersion, consentId, now } = input;

    const matches: DedupeMatch[] = [];
    for (const other of this.#galleryFor(scope)) {
      if (other.identityId === identityId) continue;
      if (other.modelVersion !== modelVersion) continue; // not comparable
      const score = similarity(vector, other.vector);
      if (score >= this.#thresholds.dedupe) matches.push({ identityId: other.identityId, score });
    }
    matches.sort((a, b) => b.score - a.score);

    const existing = this.#db
      .prepare('SELECT template_ref FROM templates WHERE identity_id = ? AND scope = ?')
      .get(identityId, scope) as { template_ref: string } | undefined;

    const templateRef = existing?.template_ref ?? `tpl_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const sealed = seal(vector, this.#masterKey, modelVersion);

    this.#db
      .prepare(
        `INSERT INTO templates (template_ref, identity_id, scope, ciphertext, iv, tag,
           wrapped_key, wrap_iv, wrap_tag, model_version, enrolled_at, consent_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(identity_id, scope) DO UPDATE SET
           ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
           wrapped_key = excluded.wrapped_key, wrap_iv = excluded.wrap_iv, wrap_tag = excluded.wrap_tag,
           model_version = excluded.model_version, enrolled_at = excluded.enrolled_at,
           consent_id = excluded.consent_id`,
      )
      .run(
        templateRef,
        identityId,
        scope,
        sealed.ciphertext,
        sealed.iv,
        sealed.tag,
        sealed.wrappedKey,
        sealed.wrapIv,
        sealed.wrapTag,
        modelVersion,
        now,
        consentId,
      );

    for (const m of matches) {
      this.#db
        .prepare(
          'INSERT INTO dedupe_flags (flag_id, scope, identity_id, matched_id, score, raised_at) VALUES (?,?,?,?,?,?)',
        )
        .run(randomUUID(), scope, identityId, m.identityId, m.score, now);
    }

    this.#log('enrol', matches.length > 0 ? 'review' : 'clear', now, identityId, scope);

    return {
      templateRef,
      replaced: existing !== undefined,
      dedupe: { status: matches.length > 0 ? 'review' : 'clear', matches },
    };
  }

  /** 1:1 verification. "Is this probe the person who claims to be presenting it?" */
  verify(input: { identityId: string; scope: string; probe: FaceVector; now: number }): IdentifyResult {
    const row = this.#db
      .prepare('SELECT * FROM templates WHERE identity_id = ? AND scope = ?')
      .get(input.identityId, input.scope) as Record<string, never> | undefined;

    if (!row) {
      this.#log('verify', 'not_enrolled', input.now, input.identityId, input.scope);
      return { matched: false, score: 0 };
    }

    const r = row as unknown as {
      model_version: string;
      ciphertext: Uint8Array;
      iv: Uint8Array;
      tag: Uint8Array;
      wrapped_key: Uint8Array;
      wrap_iv: Uint8Array;
      wrap_tag: Uint8Array;
    };
    const vector = unseal(
      fromRow({
        ciphertext: r.ciphertext,
        iv: r.iv,
        tag: r.tag,
        wrapped_key: r.wrapped_key,
        wrap_iv: r.wrap_iv,
        wrap_tag: r.wrap_tag,
        model_version: r.model_version,
      }),
      this.#masterKey,
    );

    const score = similarity(input.probe, vector);
    this.#log('verify', score >= this.#thresholds.match ? 'match' : 'no_match', input.now, input.identityId, input.scope);
    return { matched: score >= this.#thresholds.match, score };
  }

  /**
   * 1:N identification within a scope.
   *
   * Scope is what makes this tractable and what bounds the damage: a gallery is
   * one event's ticket-holders, not the whole user base.
   */
  identify(input: { scope: string; probe: FaceVector; now: number }): IdentifyResult {
    let best: { identityId: string; score: number } | undefined;
    for (const candidate of this.#galleryFor(input.scope)) {
      const score = similarity(input.probe, candidate.vector);
      if (!best || score > best.score) best = { identityId: candidate.identityId, score };
    }

    if (!best) {
      this.#log('identify', 'empty_gallery', input.now, undefined, input.scope);
      return { matched: false, score: 0 };
    }

    const matched = best.score >= this.#thresholds.match;
    this.#log('identify', matched ? 'match' : 'no_match', input.now, matched ? best.identityId : undefined, input.scope);
    return matched ? { matched: true, identityId: best.identityId, score: best.score } : { matched: false, score: best.score };
  }

  /**
   * Delete everything for an identity and issue a receipt.
   *
   * The receipt is signed so it can be handed to the person who asked, or to a
   * regulator, as evidence rather than as an assertion. It deliberately survives
   * the deletion — it is the only thing that does.
   */
  forget(identityId: string, reason: string, now: number): DeletionReceipt {
    const deleted = Number(
      this.#db.prepare('DELETE FROM templates WHERE identity_id = ?').run(identityId).changes,
    );
    this.#db.prepare('DELETE FROM dedupe_flags WHERE identity_id = ? OR matched_id = ?').run(identityId, identityId);

    const receiptId = `rcp_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const digest = this.#digest({ receiptId, identityId, deletedCount: deleted, reason, deletedAt: now });

    this.#db
      .prepare(
        'INSERT INTO deletion_receipts (receipt_id, identity_id, deleted_count, reason, deleted_at, digest) VALUES (?,?,?,?,?,?)',
      )
      .run(receiptId, identityId, deleted, reason, now, digest);

    this.#log('forget', `deleted:${deleted}`, now, identityId);

    return { receiptId, identityId, deletedCount: deleted, reason, deletedAt: now, digest };
  }

  #digest(r: Omit<DeletionReceipt, 'digest'>): string {
    return createHmac('sha256', this.#receiptKey)
      .update(r.receiptId)
      .update(' ')
      .update(r.identityId)
      .update(' ')
      .update(String(r.deletedCount))
      .update(' ')
      .update(r.reason)
      .update(' ')
      .update(String(r.deletedAt))
      .digest('hex');
  }

  verifyReceipt(receipt: DeletionReceipt): boolean {
    const expected = Buffer.from(this.#digest(receipt));
    const given = Buffer.from(receipt.digest);
    if (expected.length !== given.length) return false;
    return timingSafeEqual(expected, given);
  }

  // ─── gate manifests ──────────────────────────────────────────────────────

  /**
   * Seal an event manifest for one scanner.
   *
   * This is the one path by which template material leaves the vault, and it is
   * the exception that proves the rule: what leaves is ciphertext under a key
   * derived for one device, one event and one expiry, and the key itself is
   * released separately and later. A blob intercepted in transit is inert.
   *
   * An identity with no template is skipped rather than failing the batch — a
   * fan who withdrew consent this morning should not stop nine thousand other
   * people getting in tonight. They go through the resolution desk instead.
   */
  sealGateManifest(input: {
    scannerId: string;
    eventId: string;
    scope: string;
    credentials: readonly GateCredential[];
    sequence: number;
    expiresAt: number;
    releaseFrom: number;
    now: number;
  }): { sealed: SealedManifest; included: number; missing: string[] } {
    const templates = new Map(this.#galleryFor(input.scope).map((g) => [g.identityId, g.vector]));

    const entries: GateEntry[] = [];
    const missing: string[] = [];
    for (const c of input.credentials) {
      const template = templates.get(c.identityId);
      if (!template) {
        missing.push(c.identityId);
        continue;
      }
      entries.push({ ...c, template });
    }

    const manifest: GateManifest = {
      eventId: input.eventId,
      scannerId: input.scannerId,
      sequence: input.sequence,
      generatedAt: input.now,
      expiresAt: input.expiresAt,
      entries,
    };

    const key = deriveManifestKey(this.#manifestKey, input.scannerId, input.eventId, input.expiresAt);
    const sealed = sealManifest(manifest, key);

    this.#db
      .prepare(
        `INSERT INTO manifests (manifest_id, scanner_id, event_id, scope, credential_count, expires_at, release_from, sealed_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(scanner_id, event_id, expires_at) DO UPDATE SET
           credential_count = excluded.credential_count, sealed_at = excluded.sealed_at`,
      )
      .run(
        randomUUID(),
        input.scannerId,
        input.eventId,
        input.scope,
        entries.length,
        input.expiresAt,
        input.releaseFrom,
        input.now,
      );

    this.#log('seal_manifest', `entries:${entries.length} missing:${missing.length}`, input.now, undefined, input.scope);

    return { sealed, included: entries.length, missing };
  }

  /**
   * Release the key for a sealed manifest.
   *
   * Refused before its window and after its expiry. This is the control that
   * makes early distribution safe: a manifest sitting on a device for three days
   * cannot be opened until the night it is for.
   */
  releaseManifestKey(
    scannerId: string,
    eventId: string,
    expiresAt: number,
    now: number,
  ): { key: string } | { refused: 'UNKNOWN_MANIFEST' | 'TOO_EARLY' | 'EXPIRED'; releaseFrom?: number } {
    const row = this.#db
      .prepare('SELECT release_from, expires_at FROM manifests WHERE scanner_id = ? AND event_id = ? AND expires_at = ?')
      .get(scannerId, eventId, expiresAt) as { release_from: number; expires_at: number } | undefined;

    if (!row) {
      this.#log('release_key', 'unknown', now, undefined, eventId);
      return { refused: 'UNKNOWN_MANIFEST' };
    }
    if (now < row.release_from) {
      this.#log('release_key', 'too_early', now, undefined, eventId);
      return { refused: 'TOO_EARLY', releaseFrom: row.release_from };
    }
    if (now >= row.expires_at) {
      this.#log('release_key', 'expired', now, undefined, eventId);
      return { refused: 'EXPIRED' };
    }

    this.#db
      .prepare('UPDATE manifests SET key_released_at = ? WHERE scanner_id = ? AND event_id = ? AND expires_at = ?')
      .run(now, scannerId, eventId, expiresAt);
    this.#log('release_key', 'released', now, undefined, eventId);

    return { key: deriveManifestKey(this.#manifestKey, scannerId, eventId, expiresAt).toString('base64') };
  }

  manifestLog() {
    return this.#db
      .prepare('SELECT scanner_id, event_id, credential_count, expires_at, release_from, key_released_at FROM manifests')
      .all() as Array<{
      scanner_id: string;
      event_id: string;
      credential_count: number;
      expires_at: number;
      release_from: number;
      key_released_at: number | null;
    }>;
  }

  isEnrolled(identityId: string, scope: string): boolean {
    return (
      this.#db.prepare('SELECT 1 FROM templates WHERE identity_id = ? AND scope = ?').get(identityId, scope) !==
      undefined
    );
  }

  openFlags(scope: string) {
    return this.#db
      .prepare('SELECT flag_id, identity_id, matched_id, score, raised_at FROM dedupe_flags WHERE scope = ? AND resolved_at IS NULL ORDER BY score DESC')
      .all(scope) as Array<{ flag_id: string; identity_id: string; matched_id: string; score: number; raised_at: number }>;
  }

  resolveFlag(flagId: string, resolution: 'same_person' | 'different_people', now: number): boolean {
    return (
      Number(
        this.#db
          .prepare('UPDATE dedupe_flags SET resolved_at = ?, resolution = ? WHERE flag_id = ? AND resolved_at IS NULL')
          .run(now, resolution, flagId).changes,
      ) === 1
    );
  }

  accessLog(): Array<{ operation: string; outcome: string; at: number; identity_id: string | null }> {
    return this.#db
      .prepare('SELECT operation, outcome, at, identity_id FROM access_log ORDER BY at, rowid')
      .all() as Array<{ operation: string; outcome: string; at: number; identity_id: string | null }>;
  }

  close(): void {
    this.#db.close();
  }
}
