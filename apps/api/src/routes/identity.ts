import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  canonicalRecoveryCode,
  consentId as toConsentId,
  effectiveConsent,
  formatRecoveryCode,
  grant,
  normaliseRecoveryCode,
  identityId as toIdentityId,
  requireConsent,
  validateUnbundled,
  withdraw,
} from '@rexell/domain';
import type { ConsentPurpose, ConsentRecord, EpochMs } from '@rexell/domain';
import type { Repo } from '@rexell/db';
import { HttpError, badRequest, errorBody, notFound, statusFor } from '../errors.js';
import { VaultRejected, VaultUnavailable } from '../vault-client.js';
import type { LivenessProof } from '../vault-client.js';
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

/**
 * A fresh recovery code.
 *
 * 32 random bytes reduced to 20 Crockford base32 symbols — 100 bits, which is
 * far past anything guessable, so the rate limit on the recover route is there
 * for the abusive case rather than as a real line of defence.
 */
function newRecoveryCode(): string {
  return formatRecoveryCode(randomBytes(32));
}

/**
 * SHA-256, like the organizer API keys and for the same reason: this is 100
 * bits of CSPRNG output rather than something a person chose, so there is
 * nothing to brute-force and no reason to pay bcrypt's cost on a route that
 * an onsale crowd might hit.
 */
function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

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

  /**
   * Recover an identity on a new device.
   *
   * The code is spent when it is used and a replacement is issued in the same
   * transaction, so a code read off a screenshot or a shoulder cannot be used
   * twice. That does mean an attacker who redeems first locks the owner out —
   * but they already had the code, and a code that stayed valid forever would
   * leave them with indefinite access instead of one use the owner can notice.
   *
   * The response deliberately does not distinguish "no such code" from "that
   * code has already been used". Both are the same sentence, because telling
   * somebody their guess was once a real code is telling them something.
   */
  /**
   * Sign in with a face. One to many, across every enrolled template.
   *
   * This is the route the whole product is named after: there is nothing to
   * present, nothing to type and nothing to lose. It is also the most dangerous
   * route in the API, and three things hold it down.
   *
   * It returns an identity or it returns nothing — never a list, never a score
   * for a near miss, never "close to idn_…". A caller who could submit probes
   * and read back distances could hill-climb towards somebody else's template
   * without ever seeing it, and would eventually arrive.
   *
   * It only ever returns a MATCH-band result. The review band exists so that an
   * uncertain person at a gate meets a human; there is no human here, so an
   * uncertain sign-in is a refusal.
   *
   * And it is in the stricter rate-limit bucket, because unlike enrolment it
   * takes no identity and asserts nothing — it is the one door a script can
   * stand in front of and keep pushing.
   *
   * ⚠ Not a second factor. Until liveness detection is in place a photograph of
   * the owner's face signs in as the owner, which is exactly why the API keys
   * and recovery codes still exist and why nothing here can move money.
   */
  app.post<{ Body: { vector?: number[]; scope?: string } }>('/v1/identities/identify', async (req, reply) => {
    if (!Array.isArray(req.body?.vector)) throw badRequest('`vector` is required.');

    let result;
    try {
      result = await requireVault().identify({ scope: req.body.scope ?? 'global', probe: req.body.vector });
    } catch (e) {
      throw asHttpError(e);
    }

    if (!result.matched || !result.identityId) {
      // Deliberately the same answer whether nobody matched or somebody nearly
      // did. "Almost" is the single most useful thing an attacker can be told.
      throw new HttpError(
        404,
        'NO_MATCH',
        'No account matched that face. Try again in better light, or use a recovery code.',
      );
    }

    const row = repo.getIdentity(toIdentityId(result.identityId));
    if (!row) {
      // The vault holds a template for an identity this database has lost.
      // Signing somebody in against it would be inventing an account.
      throw new HttpError(404, 'NO_MATCH', 'No account matched that face.');
    }

    return reply.code(200).send({
      identityId: result.identityId,
      enrolled: Boolean(row.enrolled),
      // The score is the caller's own, about themselves, and it is what makes
      // the sign-in legible rather than magic.
      score: Number(result.score.toFixed(4)),
    });
  });

  app.post<{ Body: { code?: string } }>('/v1/identities/recover', async (req, reply) => {
    const raw = req.body?.code;
    if (typeof raw !== 'string' || raw.trim() === '') throw badRequest('`code` is required.');

    const normalised = normaliseRecoveryCode(raw);
    // A malformed code is refused with the same message as a wrong one. The
    // shape of a valid code is public; which strings are live is not.
    const identity = normalised
      ? repo.redeemRecoveryCode(hashRecoveryCode(canonicalRecoveryCode(normalised)), now())
      : undefined;

    if (!identity) {
      throw new HttpError(
        404,
        'RECOVERY_CODE_INVALID',
        'That recovery code is not valid. It may have been used already — each one works once.',
      );
    }

    const replacement = newRecoveryCode();
    repo.issueRecoveryCode(identity, hashRecoveryCode(replacement), now());

    const row = repo.getIdentity(identity);
    return reply.code(200).send({
      identityId: identity,
      enrolled: Boolean(row?.enrolled),
      recoveryCode: replacement,
      recoveryWarning: 'The code you just used is spent. This is its replacement — write it down.',
    });
  });

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
      liveness: LivenessProof;
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

      // Issued here, at the first moment there is something worth recovering.
      // Shown once in this response and never again — there is no route that
      // returns it and no support tool that can, which is the same rule the
      // organizer API keys follow and for the same reason.
      const code = newRecoveryCode();
      repo.issueRecoveryCode(identity, hashRecoveryCode(code), now());

      return reply.code(201).send({
        enrolled: true,
        templateRef: result.templateRef,
        replaced: result.replaced,
        dedupe: result.dedupe,
        recoveryCode: code,
        recoveryWarning: 'Write this down now. It is the only way back in from another device, and it cannot be shown again.',
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
