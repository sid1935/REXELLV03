import type { ConsentId, IdentityId } from './ids.js';
import type { EpochMs } from './time.js';
import type { Verdict } from './result.js';
import { ok, reject } from './result.js';

/**
 * Consent.
 *
 * Three properties, each of which exists because a regulator asked for it and
 * each of which is a rule rather than a checkbox:
 *
 *  1. **Append-only.** Withdrawal writes a new record; it never mutates one. The
 *     legal artefact is not "does this person consent" — it is "what did they
 *     agree to, when, and against which wording", and that history has to survive
 *     the withdrawal.
 *
 *  2. **Unbundled.** Biometric enrolment has its own purpose and its own record.
 *     It is never implied by accepting terms of service or by buying a ticket.
 *     GDPR Article 9 requires explicit consent; a purpose bundled into checkout
 *     is not explicit.
 *
 *  3. **Versioned.** Consent is to a specific wording. When the wording changes
 *     materially, existing consent goes stale and must be asked for again rather
 *     than silently carried forward.
 */
export type ConsentPurpose =
  | 'biometric_enrolment'
  | 'biometric_entry'
  | 'terms_of_service'
  | 'marketing';

/** The purposes that must never be bundled with anything else. */
export const SPECIAL_CATEGORY_PURPOSES: readonly ConsentPurpose[] = Object.freeze([
  'biometric_enrolment',
  'biometric_entry',
]);

export function isSpecialCategory(purpose: ConsentPurpose): boolean {
  return SPECIAL_CATEGORY_PURPOSES.includes(purpose);
}

export interface ConsentRecord {
  readonly id: ConsentId;
  readonly identityId: IdentityId;
  readonly purpose: ConsentPurpose;
  /** The exact wording agreed to, e.g. `biometric-v3`. */
  readonly textVersion: string;
  readonly recordedAt: EpochMs;
  readonly grantedAt?: EpochMs;
  readonly withdrawnAt?: EpochMs;
}

export type ConsentState = 'granted' | 'withdrawn' | 'stale' | 'absent';

/**
 * The record that currently governs a purpose: the most recently *recorded* one.
 *
 * Recorded, not granted. If a withdrawal and a grant somehow carry the same
 * grant timestamp, the order they were written in is what actually happened, and
 * ties resolve to the withdrawal — the safe direction.
 */
export function effectiveConsent(
  records: readonly ConsentRecord[],
  purpose: ConsentPurpose,
): ConsentRecord | undefined {
  let latest: ConsentRecord | undefined;
  for (const r of records) {
    if (r.purpose !== purpose) continue;
    if (latest === undefined) {
      latest = r;
      continue;
    }
    if (r.recordedAt > latest.recordedAt) latest = r;
    else if (r.recordedAt === latest.recordedAt && r.withdrawnAt !== undefined) latest = r;
  }
  return latest;
}

export function consentState(
  records: readonly ConsentRecord[],
  purpose: ConsentPurpose,
  currentTextVersion: string,
): ConsentState {
  const record = effectiveConsent(records, purpose);
  if (!record) return 'absent';
  if (record.withdrawnAt !== undefined) return 'withdrawn';
  if (record.grantedAt === undefined) return 'absent';
  if (record.textVersion !== currentTextVersion) return 'stale';
  return 'granted';
}

export function hasConsent(
  records: readonly ConsentRecord[],
  purpose: ConsentPurpose,
  currentTextVersion: string,
): boolean {
  return consentState(records, purpose, currentTextVersion) === 'granted';
}

/**
 * Gate an operation on consent.
 *
 * The messages are written for the person reading them, and the distinction
 * between the three failures is real: absent means ask, withdrawn means they
 * already said no and should not be nagged as though they never answered, stale
 * means the terms moved under them and that is our doing, not theirs.
 */
export function requireConsent(
  records: readonly ConsentRecord[],
  purpose: ConsentPurpose,
  currentTextVersion: string,
): Verdict<ConsentRecord> {
  const state = consentState(records, purpose, currentTextVersion);
  const record = effectiveConsent(records, purpose);

  switch (state) {
    case 'granted':
      return ok(record as ConsentRecord);
    case 'absent':
      return reject('CONSENT_REQUIRED', 'We need your permission for this first.', { purpose });
    case 'withdrawn':
      return reject(
        'CONSENT_WITHDRAWN',
        'You withdrew permission for this. You can grant it again whenever you like.',
        { purpose, withdrawnAt: record?.withdrawnAt },
      );
    case 'stale':
      return reject('CONSENT_STALE', 'Our wording changed, so we need to ask you again.', {
        purpose,
        agreedTo: record?.textVersion,
        current: currentTextVersion,
      });
  }
}

export function grant(
  id: ConsentId,
  identityId: IdentityId,
  purpose: ConsentPurpose,
  textVersion: string,
  now: EpochMs,
): ConsentRecord {
  return { id, identityId, purpose, textVersion, recordedAt: now, grantedAt: now };
}

/**
 * Withdraw.
 *
 * Returns a NEW record rather than modifying the grant. Callers must append it.
 * There is deliberately no function in this module that mutates a record.
 */
export function withdraw(
  id: ConsentId,
  previous: ConsentRecord,
  now: EpochMs,
): ConsentRecord {
  return {
    id,
    identityId: previous.identityId,
    purpose: previous.purpose,
    textVersion: previous.textVersion,
    recordedAt: now,
    withdrawnAt: now,
  };
}

/**
 * Reject a consent form that bundles a special-category purpose with others.
 *
 * Called when a client submits a batch of grants from one screen. A screen that
 * collects "terms of service and biometric enrolment" in a single act of consent
 * is exactly the pattern Article 9 exists to prohibit, and it is easiest to stop
 * at the point the batch arrives.
 */
export function validateUnbundled(purposes: readonly ConsentPurpose[]): Verdict<void> {
  const special = purposes.filter(isSpecialCategory);
  if (special.length > 0 && purposes.length > special.length) {
    return reject(
      'CONSENT_BUNDLED',
      'Biometric permission has to be asked for on its own, not together with anything else.',
      { special, submitted: purposes },
    );
  }
  if (special.length > 1) {
    return reject('CONSENT_BUNDLED', 'Each biometric permission has to be asked for separately.', { special });
  }
  return ok();
}
