import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  consentId as toConsentId,
  effectiveConsent,
  grant,
  identityId as toIdentityId,
  requireConsent,
  validateUnbundled,
  withdraw,
} from '@rexell/domain';
import type { ConsentPurpose, ConsentRecord, EpochMs } from '@rexell/domain';
import type { Repo } from '@rexell/db';
import { HttpError, badRequest, errorBody, notFound, statusFor } from '../errors.js';
import { VaultRejected, VaultUnavailable } from '../vault-client.js';
import type { VaultClient } from '../vault-client.js';

/**
 * The wording currently in force, per purpose.
 *
 * Bumping a version here invalidates every existing consent for that purpose and
 * forces a re-ask. That is the intended, and slightly painful, behaviour: it
 * should be a deliberate act with a legal review attached, not a typo fix.
 */
export const CONSENT_TEXT_VERSIONS: Readonly<Record<ConsentPurpose, string>> = Object.freeze({
  biometric_enrolment: 'biometric-enrolment-v1',
  biometric_entry: 'biometric-entry-v1',
  terms_of_service: 'tos-v1',
  marketing: 'marketing-v1',
});

const PURPOSES = Object.keys(CONSENT_TEXT_VERSIONS) as ConsentPurpose[];

interface Deps {
  repo: Repo;
  now: () => EpochMs;
  vault?: VaultClient | undefined;
}

function loadConsents(repo: Repo, identity: string): ConsentRecord[] {
  return repo.consents.forIdentity(identity).map((r) => {
    const base = {
      id: toConsentId(r.consent_id),
      identityId: toIdentityId(r.identity_id),
      purpose: r.purpose as ConsentPurpose,
      textVersion: r.text_version,
      recordedAt: r.created_at as EpochMs,
    };
    return {
      ...base,
      ...(r.granted_at !== null ? { grantedAt: r.granted_at as EpochMs } : {}),
      ...(r.withdrawn_at !== null ? { withdrawnAt: r.withdrawn_at as EpochMs } : {}),
    };
  });
}

export function identityRoutes(app: FastifyInstance, { repo, now, vault }: Deps): void {
  const requireVault = (): VaultClient => {
    if (!vault) {
      throw new HttpError(503, 'VAULT_NOT_CONFIGURED', 'Enrolment is unavailable: no identity service is configured.');
    }
    return vault;
  };

  // ─ consent ─

  app.get<{ Params: { id: string } }>('/v1/identities/:id/consents', async (req) => {
    if (!repo.getIdentity(toIdentityId(req.params.id))) throw notFound('identity', req.params.id);
    const records = loadConsents(repo, req.params.id);
    return {
      identityId: req.params.id,
      current: PURPOSES.map((purpose) => {
        const record = effectiveConsent(records, purpose);
        const verdict = requireConsent(records, purpose, CONSENT_TEXT_VERSIONS[purpose]);
        return {
          purpose,
          state: verdict.ok ? 'granted' : verdict.code.replace('CONSENT_', '').toLowerCase(),
          textVersion: record?.textVersion ?? null,
          currentTextVersion: CONSENT_TEXT_VERSIONS[purpose],
        };
      }),
      history: records.map((r) => ({
        id: r.id,
        purpose: r.purpose,
        textVersion: r.textVersion,
        recordedAt: r.recordedAt,
        grantedAt: r.grantedAt ?? null,
        withdrawnAt: r.withdrawnAt ?? null,
      })),
    };
  });

  /**
   * Grant consent.
   *
   * Takes an array so a signup screen can submit what it collected, and rejects
   * the array if it bundles a biometric purpose with anything else. Catching it
   * here means an Article 9 violation is a 422 during development rather than a
   * finding during an audit.
   */
  app.post<{ Params: { id: string }; Body: { purposes: ConsentPurpose[] } }>(
    '/v1/identities/:id/consents',
    async (req, reply) => {
      const at = now();
      const identity = toIdentityId(req.params.id);
      if (!repo.getIdentity(identity)) throw notFound('identity', req.params.id);

      const purposes = req.body?.purposes;
      if (!Array.isArray(purposes) || purposes.length === 0) {
        throw badRequest('Body must contain a non-empty `purposes` array.');
      }
      for (const p of purposes) {
        if (!PURPOSES.includes(p)) throw badRequest(`Unknown consent purpose '${p}'.`);
      }

      const unbundled = validateUnbundled(purposes);
      if (!unbundled.ok) {
        return reply.code(422).send(errorBody(unbundled.code, unbundled.message, unbundled.detail));
      }

      const written: ConsentRecord[] = [];
      repo.db.tx(() => {
        for (const purpose of purposes) {
          const record = grant(
            toConsentId(`con_${randomUUID().replace(/-/g, '').slice(0, 20)}`),
            identity,
            purpose,
            CONSENT_TEXT_VERSIONS[purpose],
            at,
          );
          repo.consents.append({
            id: record.id,
            identityId: identity,
            purpose,
            textVersion: record.textVersion,
            grantedAt: at,
            now: at,
          });
          written.push(record);
        }
      });

      return reply.code(201).send({ granted: written.map((r) => ({ id: r.id, purpose: r.purpose, textVersion: r.textVersion })) });
    },
  );

  // ─ enrolment ─

  app.post<{ Params: { id: string } }>('/v1/identities/:id/enrolment/challenge', async (req, reply) => {
    if (!repo.getIdentity(toIdentityId(req.params.id))) throw notFound('identity', req.params.id);
    try {
      return reply.code(201).send(await requireVault().challenge());
    } catch (e) {
      throw asHttpError(e);
    }
  });

  app.post<{
    Params: { id: string };
    Body: {
      scope?: string;
      vector: number[];
      liveness: { challengeId: string; nonce: string; passiveScore: number; actionCompleted: boolean };
    };
  }>('/v1/identities/:id/enrolment', async (req, reply) => {
    const identity = toIdentityId(req.params.id);
    if (!repo.getIdentity(identity)) throw notFound('identity', req.params.id);

    // Consent is checked HERE, before anything is sent to the vault. The vault
    // records which consent authorised a template, but it is not in a position
    // to judge whether that consent is current — the application plane owns the
    // consent ledger, so the application plane refuses first.
    const consents = loadConsents(repo, req.params.id);
    const verdict = requireConsent(consents, 'biometric_enrolment', CONSENT_TEXT_VERSIONS.biometric_enrolment);
    if (!verdict.ok) {
      return reply.code(statusFor(verdict.code)).send(errorBody(verdict.code, verdict.message, verdict.detail));
    }

    if (!Array.isArray(req.body?.vector)) throw badRequest('`vector` is required.');

    try {
      const result = await requireVault().enrol({
        identityId: req.params.id,
        scope: req.body.scope ?? 'global',
        consentId: verdict.value.id,
        vector: req.body.vector,
        liveness: req.body.liveness,
      });

      // Only now is the identity enrolled. Before this line a ticket bought by
      // this person would be bound to nobody, which is why `evaluatePurchase`
      // refuses an unenrolled buyer.
      repo.setEnrolled(identity, true);

      return reply.code(201).send({
        enrolled: true,
        templateRef: result.templateRef,
        replaced: result.replaced,
        dedupe: result.dedupe,
      });
    } catch (e) {
      throw asHttpError(e);
    }
  });

  /**
   * Withdraw biometric consent.
   *
   * The M2 exit criterion. Three things happen atomically from the caller's
   * point of view: a withdrawal is appended to the ledger, the template is
   * destroyed in the vault, and the identity stops being enrolled. The signed
   * receipt comes back so the person has evidence rather than a promise.
   *
   * Order matters. The vault deletion happens FIRST, and only a successful
   * deletion is followed by the ledger write — the failure we can live with is
   * "deleted but not recorded", which a retry fixes. The one we cannot live with
   * is "recorded as deleted but still stored".
   */
  app.post<{ Params: { id: string } }>('/v1/identities/:id/consents/biometric_enrolment/withdraw', async (req, reply) => {
    const identity = toIdentityId(req.params.id);
    if (!repo.getIdentity(identity)) throw notFound('identity', req.params.id);

    const consents = loadConsents(repo, req.params.id);
    const previous = effectiveConsent(consents, 'biometric_enrolment');
    if (!previous || previous.withdrawnAt !== undefined) {
      return reply
        .code(409)
        .send(errorBody('NOTHING_TO_WITHDRAW', 'There is no active biometric permission to withdraw.'));
    }

    let receipt;
    try {
      receipt = await requireVault().forget({ identityId: req.params.id, reason: 'consent_withdrawn' });
    } catch (e) {
      throw asHttpError(e);
    }

    repo.db.tx(() => {
      const record = withdraw(toConsentId(`con_${randomUUID().replace(/-/g, '').slice(0, 20)}`), previous, now());
      repo.consents.append({
        id: record.id,
        identityId: identity,
        purpose: 'biometric_enrolment',
        textVersion: record.textVersion,
        withdrawnAt: now(),
        now: now(),
      });
      repo.setEnrolled(identity, false);
    });

    return reply.code(200).send({ withdrawn: true, enrolled: false, receipt });
  });
}

function asHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof VaultUnavailable) {
    // 503, never a silent pass. A vault that is down must not fail open into
    // "this person is enrolled".
    return new HttpError(503, 'VAULT_UNAVAILABLE', e.message);
  }
  if (e instanceof VaultRejected) {
    return new HttpError(e.status === 403 ? 403 : e.status, e.code, e.message);
  }
  return new HttpError(500, 'INTERNAL', 'Something went wrong on our side.');
}
