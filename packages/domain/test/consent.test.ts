import { describe, expect, it } from 'vitest';
import {
  DAY,
  consentId,
  consentState,
  effectiveConsent,
  epochMs,
  grant,
  hasConsent,
  isSpecialCategory,
  requireConsent,
  validateUnbundled,
  withdraw,
} from '../src/index.js';
import type { ConsentRecord } from '../src/index.js';
import { ALICE, T0 } from './fixtures.js';

const V3 = 'biometric-v3';
const LATER = epochMs(T0 + 30 * DAY);

const granted = grant(consentId('con_1'), ALICE, 'biometric_enrolment', V3, T0);

describe('consent is append-only', () => {
  it('withdrawal produces a new record and leaves the original untouched', () => {
    const before = { ...granted };
    const w = withdraw(consentId('con_2'), granted, LATER);

    expect(granted).toEqual(before);
    expect(w.id).not.toBe(granted.id);
    expect(w.withdrawnAt).toBe(LATER);
    expect(w.grantedAt).toBeUndefined();
    // The wording that was agreed to survives the withdrawal — it is the legal
    // artefact, and it has to outlive the permission.
    expect(w.textVersion).toBe(V3);
  });

  it('the most recently recorded record governs', () => {
    const w = withdraw(consentId('con_2'), granted, LATER);
    const regranted = grant(consentId('con_3'), ALICE, 'biometric_enrolment', V3, epochMs(LATER + DAY));

    expect(effectiveConsent([granted, w], 'biometric_enrolment')?.id).toBe('con_2');
    expect(effectiveConsent([granted, w, regranted], 'biometric_enrolment')?.id).toBe('con_3');
    // Order in the array must not matter — the database will not return them sorted.
    expect(effectiveConsent([regranted, granted, w], 'biometric_enrolment')?.id).toBe('con_3');
  });

  it('resolves a same-instant tie towards withdrawal', () => {
    const w: ConsentRecord = { ...withdraw(consentId('con_2'), granted, T0), recordedAt: T0 };
    expect(effectiveConsent([granted, w], 'biometric_enrolment')?.id).toBe('con_2');
    expect(effectiveConsent([w, granted], 'biometric_enrolment')?.id).toBe('con_2');
  });
});

describe('consent state', () => {
  it('reports granted, withdrawn, stale and absent distinctly', () => {
    const w = withdraw(consentId('con_2'), granted, LATER);

    expect(consentState([granted], 'biometric_enrolment', V3)).toBe('granted');
    expect(consentState([granted, w], 'biometric_enrolment', V3)).toBe('withdrawn');
    expect(consentState([granted], 'biometric_enrolment', 'biometric-v4')).toBe('stale');
    expect(consentState([], 'biometric_enrolment', V3)).toBe('absent');
  });

  it('does not let consent for one purpose satisfy another', () => {
    const terms = grant(consentId('con_t'), ALICE, 'terms_of_service', 'tos-v9', T0);
    expect(hasConsent([terms], 'biometric_enrolment', V3)).toBe(false);
    expect(hasConsent([terms], 'terms_of_service', 'tos-v9')).toBe(true);
  });

  it('goes stale when the wording changes, rather than carrying forward', () => {
    const v = requireConsent([granted], 'biometric_enrolment', 'biometric-v4');
    expect(v).toMatchObject({ ok: false, code: 'CONSENT_STALE' });
    if (!v.ok) expect(v.detail).toMatchObject({ agreedTo: V3, current: 'biometric-v4' });
  });
});

describe('requireConsent distinguishes its three failures', () => {
  it('asks when nothing was ever given', () => {
    expect(requireConsent([], 'biometric_enrolment', V3)).toMatchObject({ ok: false, code: 'CONSENT_REQUIRED' });
  });

  it('does not nag somebody who already said no', () => {
    const w = withdraw(consentId('con_2'), granted, LATER);
    const v = requireConsent([granted, w], 'biometric_enrolment', V3);
    expect(v).toMatchObject({ ok: false, code: 'CONSENT_WITHDRAWN' });
    if (!v.ok) expect(v.message).toMatch(/again whenever you like/);
  });

  it('passes and hands back the governing record', () => {
    const v = requireConsent([granted], 'biometric_enrolment', V3);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.id).toBe('con_1');
  });
});

describe('biometric consent must be unbundled', () => {
  it('rejects a form that collects biometrics alongside anything else', () => {
    // The Article 9 failure mode: "accept terms and enrol your face" as one act.
    const v = validateUnbundled(['terms_of_service', 'biometric_enrolment']);
    expect(v).toMatchObject({ ok: false, code: 'CONSENT_BUNDLED' });
  });

  it('rejects two biometric purposes collected together', () => {
    expect(validateUnbundled(['biometric_enrolment', 'biometric_entry'])).toMatchObject({
      ok: false,
      code: 'CONSENT_BUNDLED',
    });
  });

  it('accepts a biometric purpose on its own', () => {
    expect(validateUnbundled(['biometric_enrolment']).ok).toBe(true);
  });

  it('leaves ordinary purposes free to be bundled', () => {
    expect(validateUnbundled(['terms_of_service', 'marketing']).ok).toBe(true);
  });

  it('knows which purposes are special category', () => {
    expect(isSpecialCategory('biometric_enrolment')).toBe(true);
    expect(isSpecialCategory('biometric_entry')).toBe(true);
    expect(isSpecialCategory('marketing')).toBe(false);
  });
});
