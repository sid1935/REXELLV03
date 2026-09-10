import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { EpochMs } from '@rexell/domain';
import { CALIBRATED_BANDS, FairQueue, MODEL, Scorer, buildEdges, cluster, riskMultipliers } from '@rexell/risk';
import type { Bands, Observation, RawSignals, RiskVerdict } from '@rexell/risk';
import type { Repo } from '@rexell/db';
import { badRequest, errorBody, notFound } from '../errors.js';

/**
 * The onsale defence, wired to HTTP.
 *
 * Two layers on two timescales. The queue and the scorer run inline and decide
 * in microseconds; the graph runs nightly and cannot save the purchase it
 * describes, only the ones after it. Both are here because neither is
 * sufficient — and because the thing that actually stops a determined operator
 * is the identity binding at the gate, not either of these.
 */

export interface OnsaleDeps {
  repo: Repo;
  now: () => EpochMs;
  queue?: FairQueue | undefined;
}

/** Shared by the route and by `purchaserContext`, so one score governs a session. */
export class RiskEngine {
  readonly scorer: Scorer;
  #multipliers = new Map<string, number>();
  #recent = new Map<string, { verdict: RiskVerdict; score: number; at: number }>();

  constructor(bands: Bands = CALIBRATED_BANDS as Bands) {
    this.scorer = new Scorer(MODEL, bands);
  }

  score(signals: RawSignals, now: number): { score: number; verdict: RiskVerdict; reasons: string[] } {
    const result = this.scorer.score(signals);

    // The graph multiplier from last night's clustering, applied in log-odds so
    // it shifts the decision rather than saturating it.
    const multiplier = signals.identityId ? (this.#multipliers.get(signals.identityId) ?? 1) : 1;
    const adjusted =
      multiplier === 1
        ? result.score
        : 1 / (1 + Math.exp(-(Math.log(result.score / (1 - result.score)) + Math.log2(multiplier))));

    const verdict = this.scorer.score({ ...signals }).verdict;
    const finalVerdict: RiskVerdict =
      adjusted > result.score && adjusted >= (CALIBRATED_BANDS as Bands).throttle && verdict === 'allow'
        ? 'throttle'
        : verdict;

    const reasons: string[] = result.topReasons.map((r) => String(r.feature));
    if (multiplier > 1) reasons.unshift('cluster');

    if (signals.identityId) {
      this.#recent.set(signals.identityId, { verdict: finalVerdict, score: adjusted, at: now });
    }
    return { score: adjusted, verdict: finalVerdict, reasons };
  }

  /** The verdict a purchase should be judged under, if one was computed. */
  verdictFor(identityId: string): RiskVerdict | undefined {
    return this.#recent.get(identityId)?.verdict;
  }

  setMultipliers(m: Map<string, number>): void {
    this.#multipliers = m;
  }

  get clusterCount(): number {
    return this.#multipliers.size;
  }
}

export function onsaleRoutes(app: FastifyInstance, { repo, now, queue }: OnsaleDeps, risk: RiskEngine): void {
  const requireQueue = (): FairQueue => {
    if (!queue) throw badRequest('No onsale queue is configured for this deployment.');
    return queue;
  };

  /**
   * Join the waiting room.
   *
   * Scored on the way in, so a farm's sessions are already carrying a verdict
   * before they reach inventory. Rejoining returns the place already held.
   */
  app.post<{ Body: { sessionId?: string; identityId?: string; signals?: Partial<RawSignals> } }>(
    '/v1/onsale/join',
    async (req, reply) => {
      const at = now();
      const q = requireQueue();
      const sessionId = req.body?.sessionId ?? `ses_${randomBytes(8).toString('hex')}`;
      const identityId = req.body?.identityId;

      const signals: RawSignals = {
        sessionId,
        ...(identityId ? { identityId } : {}),
        deviceFingerprint: req.body?.signals?.deviceFingerprint ?? sessionId,
        asn: req.body?.signals?.asn ?? 0,
        asnIsDatacenter: req.body?.signals?.asnIsDatacenter ?? false,
        deviceAttested: req.body?.signals?.deviceAttested ?? false,
        dwellMs: req.body?.signals?.dwellMs ?? 0,
        interActionMs: req.body?.signals?.interActionMs ?? [],
        pointerTurnsPer100px: req.body?.signals?.pointerTurnsPer100px ?? 0,
        pointerObserved: req.body?.signals?.pointerObserved ?? false,
        accountAgeHours: req.body?.signals?.accountAgeHours ?? 0,
        requestsLastMinute: req.body?.signals?.requestsLastMinute ?? 0,
        accountsOnDevice: req.body?.signals?.accountsOnDevice ?? 1,
        accountsOnCard: req.body?.signals?.accountsOnCard ?? 1,
        seatSelectionMs: req.body?.signals?.seatSelectionMs ?? 0,
      };

      const assessed = risk.score(signals, at);

      /**
       * A blocked session is refused a place, so a farm cannot occupy the queue
       * it is not allowed to buy from.
       *
       * Except for an enrolled identity, where a block is softened to friction.
       * The reasoning matters: the score is wrong about roughly one fan in a
       * hundred, and refusing them at the door with no recourse is the worst
       * outcome this system can produce. ReXell has something better than a
       * CAPTCHA to fall back on — the person has already proved they are a
       * specific human, and biometric dedupe caps how many accounts one human
       * can hold. So enrolment is treated as strong evidence and the answer to
       * "we think you are a script" becomes "then verify, and queue".
       *
       * A farm cannot use this: enrolling every mule is exactly what dedupe
       * catches, and the graph multiplier survives the downgrade.
       */
      const enrolled = identityId ? repo.getIdentity(identityId as never)?.enrolled === 1 : false;
      const verdict = assessed.verdict === 'block' && enrolled ? 'challenge' : assessed.verdict;

      if (verdict === 'block') {
        return reply.code(403).send(
          errorBody(
            'RISK_BLOCKED',
            'We could not verify this request. Setting up your ReXell ID will let you join the queue.',
          ),
        );
      }

      // The dedupe key is the identity when known, the device otherwise. A farm
      // can open a thousand sessions; it cannot use them to jump.
      const place = q.join(sessionId, identityId ?? signals.deviceFingerprint, at);

      return reply.code(200).send({
        sessionId,
        position: place.position,
        ahead: place.ahead,
        estimatedWaitMs: place.estimatedWaitMs,
        rejoined: place.rejoined,
        // The score is never returned to the client. It tells an adversary
        // exactly how close they are to passing, which is a free gradient.
        friction: verdict === 'allow' ? 'none' : verdict,
        ...(place.token ? { admissionToken: place.token } : {}),
      });
    },
  );

  app.post<{ Body: { sessionId: string } }>('/v1/onsale/poll', async (req, reply) => {
    const at = now();
    const q = requireQueue();
    const sessionId = req.body?.sessionId;
    if (!sessionId) throw badRequest('sessionId is required.');

    if (!q.isAdmitted(sessionId)) {
      const status = q.status(at);
      return reply.code(200).send({ admitted: false, waiting: status.waiting, estimatedWaitMs: status.estimatedDrainMs });
    }
    return reply.code(200).send({ admitted: true, admissionToken: q.issueToken(sessionId, at) });
  });

  /** Release the next batch. A scheduler calls this; exposed for tests and ops. */
  app.post('/v1/onsale/drain', async (_req, reply) => {
    const q = requireQueue();
    const released = q.drain(now());
    q.sweep();
    return reply.code(200).send({ released: released.length, ...q.status(now()) });
  });

  app.get('/v1/onsale/status', async () => {
    if (!queue) return { configured: false };
    return { configured: true, ...queue.status(now()), clusteredIdentities: risk.clusterCount };
  });

  /**
   * The nightly graph pass.
   *
   * Cannot help the onsale it is run after. Its output is a multiplier applied
   * at the next one, which is the whole shape of this defence.
   */
  app.post('/v1/risk/cluster', async (_req, reply) => {
    const observations: Observation[] = repo.db
      .all<{ identity_id: string; kind: string; value: string }>(
        `SELECT identity_id, kind, value FROM risk_signals WHERE kind IN ('device','card','asn','dedupe')`,
      )
      .reduce<Observation[]>((acc, row) => {
        let entry = acc.find((o) => o.identityId === row.identity_id);
        if (!entry) {
          entry = { identityId: row.identity_id };
          acc.push(entry);
        }
        const mutable = entry as { -readonly [K in keyof Observation]: Observation[K] };
        if (row.kind === 'device') mutable.deviceFingerprint = row.value;
        if (row.kind === 'card') mutable.cardFingerprint = row.value;
        if (row.kind === 'asn') mutable.asn = Number(row.value);
        if (row.kind === 'dedupe') mutable.dedupeMatchedIdentity = row.value;
        return acc;
      }, []);

    const clusters = cluster(buildEdges(observations));
    risk.setMultipliers(riskMultipliers(clusters));

    return reply.code(200).send({
      observations: observations.length,
      clusters: clusters.length,
      suspicious: clusters.filter((c) => c.suspicious).length,
      largest: clusters[0]?.size ?? 0,
    });
  });

  /**
   * The review console's data.
   *
   * A cluster is an accusation, so it is presented with what it is built on —
   * which edges, how many, and who is in it — rather than as a verdict. Somebody
   * has to be able to look at this and say "that is a university, not a farm".
   */
  app.get('/v1/risk/clusters', async () => {
    const observations: Observation[] = repo.db
      .all<{ identity_id: string; kind: string; value: string }>('SELECT identity_id, kind, value FROM risk_signals')
      .reduce<Observation[]>((acc, row) => {
        let entry = acc.find((o) => o.identityId === row.identity_id);
        if (!entry) {
          entry = { identityId: row.identity_id };
          acc.push(entry);
        }
        const mutable = entry as { -readonly [K in keyof Observation]: Observation[K] };
        if (row.kind === 'device') mutable.deviceFingerprint = row.value;
        if (row.kind === 'card') mutable.cardFingerprint = row.value;
        if (row.kind === 'asn') mutable.asn = Number(row.value);
        if (row.kind === 'dedupe') mutable.dedupeMatchedIdentity = row.value;
        return acc;
      }, []);

    return {
      clusters: cluster(buildEdges(observations))
        .filter((c) => c.suspicious)
        .slice(0, 50)
        .map((c) => ({
          id: c.id,
          size: c.size,
          score: Number(c.score.toFixed(1)),
          edges: c.edgeCounts,
          identities: c.identities.slice(0, 20),
        })),
    };
  });

  /** Record a signal for the nightly pass. Called from checkout and enrolment. */
  app.post<{ Body: { identityId: string; kind: string; value: string } }>(
    '/v1/risk/signals',
    async (req, reply) => {
      const b = req.body;
      if (!b?.identityId || !b.kind || !b.value) throw badRequest('identityId, kind and value are required.');
      if (!repo.getIdentity(b.identityId as never)) throw notFound('identity', b.identityId);

      repo.db.run(
        'INSERT INTO risk_signals (signal_id, identity_id, kind, value, observed_at) VALUES (?,?,?,?,?)',
        `sig_${randomBytes(10).toString('hex')}`,
        b.identityId,
        b.kind,
        b.value,
        now(),
      );
      return reply.code(201).send({ recorded: true });
    },
  );
}
