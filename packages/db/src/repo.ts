import { createHash } from 'node:crypto';
import {
  epochMs,
  eventId as toEventId,
  identityId as toIdentityId,
  laneId as toLaneId,
  listingId as toListingId,
  minor,
  organizerId as toOrganizerId,
  templateRef as toTemplateRef,
  ticketId as toTicketId,
  tierId as toTierId,
} from '@rexell/domain';
import type {
  Delta,
  EntryAttestation,
  EpochMs,
  EventDef,
  IdentityId,
  Listing,
  Manifest,
  ManifestEntry,
  Minor,
  ResalePolicy,
  SplitResult,
  Ticket,
  TicketTier,
  TierAvailability,
} from '@rexell/domain';
import { Db, newId } from './db.js';

// ─── row shapes ──────────────────────────────────────────────────────────────

interface EventRow {
  event_id: string;
  organizer_id: string;
  name: string;
  capacity: number;
  sales_open_at: number;
  sales_close_at: number;
  doors_open_at: number;
  ends_at: number;
  max_tickets_per_identity: number;
  minimum_age: number | null;
  allow_reentry: number;
  policy_hash: string;
  manifest_sequence: number;
}

interface TierRow {
  tier_id: string;
  event_id: string;
  name: string;
  face_value: number;
  allocation: number;
  sold: number;
  held: number;
  resale_mode: 'bound' | 'capped';
  max_price_bps: number;
  min_price_bps: number;
  resale_opens_at: number;
  resale_closes_at: number;
  cooldown_ms: number;
  max_resales_per_ticket: number;
  max_active_listings_per_identity: number;
  organizer_bps: number;
  platform_bps: number;
  rights_holder_bps: number;
}

interface TicketRow {
  ticket_id: string;
  event_id: string;
  tier_id: string;
  owner_identity_id: string;
  state: Ticket['state'];
  acquired_at: number;
  resale_count: number;
  seat: string | null;
  redeemed_at: number | null;
  revoked_reason: string | null;
  token_id: string | null;
  mint_state: string;
}

interface ListingRow {
  listing_id: string;
  ticket_id: string;
  seller_identity_id: string;
  price_minor: number;
  state: Listing['state'];
  listed_at: number;
}

export interface IdentityRow {
  identity_id: string;
  enrolled: number;
  blocked: number;
  age_years: number | null;
  risk_tier: string;
}

// ─── mappers ─────────────────────────────────────────────────────────────────

function toResalePolicy(r: TierRow): ResalePolicy {
  return {
    mode: r.resale_mode,
    maxPriceBps: r.max_price_bps,
    minPriceBps: r.min_price_bps,
    opensAt: epochMs(r.resale_opens_at),
    closesAt: epochMs(r.resale_closes_at),
    cooldownMs: r.cooldown_ms,
    maxResalesPerTicket: r.max_resales_per_ticket,
    maxActiveListingsPerIdentity: r.max_active_listings_per_identity,
    splits: {
      organizerBps: r.organizer_bps,
      platformBps: r.platform_bps,
      rightsHolderBps: r.rights_holder_bps,
    },
  };
}

function toTier(r: TierRow): TicketTier {
  return {
    id: toTierId(r.tier_id),
    eventId: toEventId(r.event_id),
    name: r.name,
    faceValue: minor(r.face_value),
    allocation: r.allocation,
    resale: toResalePolicy(r),
  };
}

function toEvent(e: EventRow, tiers: readonly TicketTier[]): EventDef {
  const base = {
    id: toEventId(e.event_id),
    organizerId: toOrganizerId(e.organizer_id),
    name: e.name,
    capacity: e.capacity,
    salesOpenAt: epochMs(e.sales_open_at),
    salesCloseAt: epochMs(e.sales_close_at),
    doorsOpenAt: epochMs(e.doors_open_at),
    endsAt: epochMs(e.ends_at),
    tiers,
    maxTicketsPerIdentity: e.max_tickets_per_identity,
    allowReentry: e.allow_reentry === 1,
  };
  // exactOptionalPropertyTypes: an absent minimum age is an absent key, not
  // `undefined`, because "no age gate" and "age gate we failed to load" must not
  // be the same value.
  return e.minimum_age === null ? base : { ...base, minimumAge: e.minimum_age };
}

function toTicket(r: TicketRow): Ticket {
  const base = {
    id: toTicketId(r.ticket_id),
    eventId: toEventId(r.event_id),
    tierId: toTierId(r.tier_id),
    ownerIdentityId: toIdentityId(r.owner_identity_id),
    state: r.state,
    acquiredAt: epochMs(r.acquired_at),
    resaleCount: r.resale_count,
  };
  return {
    ...base,
    ...(r.seat !== null ? { seat: r.seat } : {}),
    ...(r.redeemed_at !== null ? { redeemedAt: epochMs(r.redeemed_at) } : {}),
    ...(r.revoked_reason !== null ? { revokedReason: r.revoked_reason } : {}),
  };
}

function toListing(r: ListingRow): Listing {
  return {
    id: toListingId(r.listing_id),
    ticketId: toTicketId(r.ticket_id),
    sellerIdentityId: toIdentityId(r.seller_identity_id),
    price: minor(r.price_minor),
    state: r.state,
    listedAt: epochMs(r.listed_at),
  };
}

/**
 * Canonical hash of the terms an organizer is committing to.
 *
 * This is what gets written on chain at event creation, and it is why an
 * organizer cannot quietly loosen a price cap after inventory has sold. Only the
 * fields that constitute the deal go in — renaming an event does not change it.
 */
export function policyHash(event: {
  capacity: number;
  maxTicketsPerIdentity: number;
  tiers: readonly TicketTier[];
}): string {
  const canonical = JSON.stringify({
    capacity: event.capacity,
    maxTicketsPerIdentity: event.maxTicketsPerIdentity,
    tiers: [...event.tiers]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((t) => ({
        id: t.id,
        faceValue: t.faceValue,
        allocation: t.allocation,
        resale: {
          mode: t.resale.mode,
          maxPriceBps: t.resale.maxPriceBps,
          minPriceBps: t.resale.minPriceBps,
          opensAt: t.resale.opensAt,
          closesAt: t.resale.closesAt,
          cooldownMs: t.resale.cooldownMs,
          maxResalesPerTicket: t.resale.maxResalesPerTicket,
          maxActiveListingsPerIdentity: t.resale.maxActiveListingsPerIdentity,
          splits: t.resale.splits,
        },
      })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── repositories ────────────────────────────────────────────────────────────

export class Repo {
  readonly consents: ConsentRepo;

  constructor(readonly db: Db) {
    this.consents = new ConsentRepo(db);
  }

  // ─ organizers & identities ─

  createOrganizer(name: string, now: EpochMs, id = newId('organizer')): string {
    this.db.run('INSERT INTO organizers (organizer_id, name, created_at) VALUES (?,?,?)', id, name, now);
    return id;
  }

  createIdentity(
    opts: { enrolled?: boolean; blocked?: boolean; ageYears?: number; id?: string },
    now: EpochMs,
  ): IdentityId {
    const id = opts.id ?? newId('identity');
    this.db.run(
      'INSERT INTO identities (identity_id, enrolled, blocked, age_years, created_at) VALUES (?,?,?,?,?)',
      id,
      opts.enrolled === false ? 0 : 1,
      opts.blocked ? 1 : 0,
      opts.ageYears ?? null,
      now,
    );
    return toIdentityId(id);
  }

  getIdentity(id: IdentityId): IdentityRow | undefined {
    return this.db.get<IdentityRow>('SELECT * FROM identities WHERE identity_id = ?', id);
  }

  setEnrolled(id: IdentityId, enrolled: boolean): void {
    this.db.run('UPDATE identities SET enrolled = ? WHERE identity_id = ?', enrolled ? 1 : 0, id);
  }

  // ─ events ─

  createEvent(event: EventDef, now: EpochMs): void {
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO events (event_id, organizer_id, name, capacity, sales_open_at, sales_close_at,
           doors_open_at, ends_at, max_tickets_per_identity, minimum_age, allow_reentry, policy_hash, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        event.id,
        event.organizerId,
        event.name,
        event.capacity,
        event.salesOpenAt,
        event.salesCloseAt,
        event.doorsOpenAt,
        event.endsAt,
        event.maxTicketsPerIdentity,
        event.minimumAge ?? null,
        event.allowReentry ? 1 : 0,
        policyHash(event),
        now,
      );
      for (const t of event.tiers) {
        this.db.run(
          `INSERT INTO tiers (tier_id, event_id, name, face_value, allocation, resale_mode,
             max_price_bps, min_price_bps, resale_opens_at, resale_closes_at, cooldown_ms,
             max_resales_per_ticket, max_active_listings_per_identity,
             organizer_bps, platform_bps, rights_holder_bps)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          t.id,
          t.eventId,
          t.name,
          t.faceValue,
          t.allocation,
          t.resale.mode,
          t.resale.maxPriceBps,
          t.resale.minPriceBps,
          t.resale.opensAt,
          t.resale.closesAt,
          t.resale.cooldownMs,
          t.resale.maxResalesPerTicket,
          t.resale.maxActiveListingsPerIdentity,
          t.resale.splits.organizerBps,
          t.resale.splits.platformBps,
          t.resale.splits.rightsHolderBps,
        );
      }
    });
  }

  getEvent(id: string): EventDef | undefined {
    const e = this.db.get<EventRow>('SELECT * FROM events WHERE event_id = ?', id);
    if (!e) return undefined;
    const tiers = this.db.all<TierRow>('SELECT * FROM tiers WHERE event_id = ? ORDER BY tier_id', id).map(toTier);
    return toEvent(e, tiers);
  }

  getEventRow(id: string): EventRow | undefined {
    return this.db.get<EventRow>('SELECT * FROM events WHERE event_id = ?', id);
  }

  getTier(id: string): { tier: TicketTier; availability: TierAvailability } | undefined {
    const r = this.db.get<TierRow>('SELECT * FROM tiers WHERE tier_id = ?', id);
    if (!r) return undefined;
    return { tier: toTier(r), availability: { sold: r.sold, held: r.held } };
  }

  /** Tickets this identity holds for an event, counting anything still live. */
  ticketsHeldForEvent(identity: IdentityId, event: string): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tickets
       WHERE owner_identity_id = ? AND event_id = ? AND state IN ('held','issued','listed','redeemed')`,
      identity,
      event,
    );
    return row?.n ?? 0;
  }

  // ─ inventory ─

  /**
   * Take `quantity` units of inventory, or take none.
   *
   * The whole concurrency story of an onsale is this one statement. The
   * availability check and the decrement are the same atomic write, so two
   * requests for the last ticket cannot both observe it as available: the second
   * `UPDATE` matches zero rows and we hand back `null`.
   *
   * Reading availability first and then writing — the obvious implementation —
   * oversells under load, and the failure only shows up at a turnstile.
   */
  reserve(tierId: string, quantity: number, identity: IdentityId, expiresAt: EpochMs, now: EpochMs): string | null {
    return this.db.tx(() => {
      const changed = this.db.run(
        'UPDATE tiers SET held = held + ? WHERE tier_id = ? AND (allocation - sold - held) >= ?',
        quantity,
        tierId,
        quantity,
      );
      if (changed !== 1) return null;

      const holdId = newId('hold');
      this.db.run(
        `INSERT INTO holds (hold_id, tier_id, identity_id, quantity, state, expires_at, created_at)
         VALUES (?,?,?,?,'active',?,?)`,
        holdId,
        tierId,
        identity,
        quantity,
        expiresAt,
        now,
      );
      return holdId;
    });
  }

  /** Convert a hold into sold inventory. Returns false if the hold is gone or expired. */
  convertHold(holdId: string, now: EpochMs): boolean {
    return this.db.tx(() => {
      const hold = this.db.get<{ tier_id: string; quantity: number; expires_at: number }>(
        `SELECT tier_id, quantity, expires_at FROM holds WHERE hold_id = ? AND state = 'active'`,
        holdId,
      );
      if (!hold || hold.expires_at <= now) return false;

      const moved = this.db.run(
        'UPDATE tiers SET held = held - ?, sold = sold + ? WHERE tier_id = ? AND held >= ?',
        hold.quantity,
        hold.quantity,
        hold.tier_id,
        hold.quantity,
      );
      if (moved !== 1) return false;

      this.db.run(`UPDATE holds SET state = 'converted' WHERE hold_id = ?`, holdId);
      return true;
    });
  }

  /**
   * Give back inventory whose hold ran out.
   *
   * Called on a timer and also lazily before availability is read, because a
   * sweeper that is a few seconds late must never be the reason an event looks
   * sold out.
   */
  releaseExpiredHolds(now: EpochMs): number {
    return this.db.tx(() => {
      const expired = this.db.all<{ hold_id: string; tier_id: string; quantity: number }>(
        `SELECT hold_id, tier_id, quantity FROM holds WHERE state = 'active' AND expires_at <= ?`,
        now,
      );
      for (const h of expired) {
        this.db.run('UPDATE tiers SET held = held - ? WHERE tier_id = ? AND held >= ?', h.quantity, h.tier_id, h.quantity);
        this.db.run(`UPDATE holds SET state = 'released' WHERE hold_id = ?`, h.hold_id);
        this.db.run(`UPDATE orders SET state = 'expired' WHERE hold_id = ? AND state = 'pending'`, h.hold_id);
      }
      return expired.length;
    });
  }

  // ─ orders ─

  createOrder(o: {
    identityId: IdentityId;
    eventId: string;
    tierId: string;
    holdId: string;
    quantity: number;
    amount: Minor;
    riskVerdict: string;
    now: EpochMs;
  }): string {
    const id = newId('order');
    this.db.run(
      `INSERT INTO orders (order_id, identity_id, event_id, tier_id, hold_id, quantity, amount_minor,
         state, risk_verdict, created_at)
       VALUES (?,?,?,?,?,?,?,'pending',?,?)`,
      id,
      o.identityId,
      o.eventId,
      o.tierId,
      o.holdId,
      o.quantity,
      o.amount,
      o.riskVerdict,
      o.now,
    );
    return id;
  }

  getOrder(id: string) {
    return this.db.get<{
      order_id: string;
      identity_id: string;
      event_id: string;
      tier_id: string;
      hold_id: string | null;
      quantity: number;
      amount_minor: number;
      state: string;
    }>('SELECT * FROM orders WHERE order_id = ?', id);
  }

  markOrderPaid(id: string, authRef: string, now: EpochMs): boolean {
    return (
      this.db.run(
        `UPDATE orders SET state = 'paid', auth_ref = ?, paid_at = ? WHERE order_id = ? AND state = 'pending'`,
        authRef,
        now,
        id,
      ) === 1
    );
  }

  // ─ tickets ─

  issueTicket(t: {
    eventId: string;
    tierId: string;
    owner: IdentityId;
    orderId: string;
    now: EpochMs;
    seat?: string;
  }): string {
    const id = newId('ticket');
    this.db.run(
      `INSERT INTO tickets (ticket_id, event_id, tier_id, owner_identity_id, order_id, state,
         acquired_at, resale_count, seat, created_at)
       VALUES (?,?,?,?,?,'issued',?,0,?,?)`,
      id,
      t.eventId,
      t.tierId,
      t.owner,
      t.orderId,
      t.now,
      t.seat ?? null,
      t.now,
    );
    return id;
  }

  getTicket(id: string): Ticket | undefined {
    const r = this.db.get<TicketRow>('SELECT * FROM tickets WHERE ticket_id = ?', id);
    return r ? toTicket(r) : undefined;
  }

  ticketsByOwner(owner: IdentityId): Ticket[] {
    return this.db
      .all<TicketRow>('SELECT * FROM tickets WHERE owner_identity_id = ? ORDER BY created_at', owner)
      .map(toTicket);
  }

  /** Persist a ticket the domain state machine has already produced. */
  saveTicket(t: Ticket): void {
    this.db.run(
      `UPDATE tickets SET owner_identity_id = ?, state = ?, acquired_at = ?, resale_count = ?,
         redeemed_at = ?, revoked_reason = ? WHERE ticket_id = ?`,
      t.ownerIdentityId,
      t.state,
      t.acquiredAt,
      t.resaleCount,
      t.redeemedAt ?? null,
      t.revokedReason ?? null,
      t.id,
    );
  }

  // ─ listings ─

  createListing(l: { ticketId: string; seller: IdentityId; price: Minor; now: EpochMs }): string {
    const id = newId('listing');
    this.db.run(
      `INSERT INTO listings (listing_id, ticket_id, seller_identity_id, price_minor, state, listed_at)
       VALUES (?,?,?,?,'active',?)`,
      id,
      l.ticketId,
      l.seller,
      l.price,
      l.now,
    );
    return id;
  }

  getListing(id: string): Listing | undefined {
    const r = this.db.get<ListingRow>('SELECT * FROM listings WHERE listing_id = ?', id);
    return r ? toListing(r) : undefined;
  }

  activeListingsFor(seller: IdentityId): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM listings WHERE seller_identity_id = ? AND state = 'active'`,
      seller,
    );
    return row?.n ?? 0;
  }

  listingsForEvent(eventId: string): Listing[] {
    return this.db
      .all<ListingRow>(
        `SELECT l.* FROM listings l JOIN tickets t ON t.ticket_id = l.ticket_id
         WHERE t.event_id = ? AND l.state = 'active' ORDER BY l.listed_at`,
        eventId,
      )
      .map(toListing);
  }

  /** Claim a listing exactly once. The `state = 'active'` predicate is the race guard. */
  claimListing(id: string, buyer: IdentityId, now: EpochMs): boolean {
    return (
      this.db.run(
        `UPDATE listings SET state = 'sold', sold_at = ?, buyer_identity_id = ?
         WHERE listing_id = ? AND state = 'active'`,
        now,
        buyer,
        id,
      ) === 1
    );
  }

  cancelListing(id: string): boolean {
    return this.db.run(`UPDATE listings SET state = 'cancelled' WHERE listing_id = ? AND state = 'active'`, id) === 1;
  }

  recordSettlement(s: { listingId: string; ticketId: string; split: SplitResult; now: EpochMs }): string {
    const id = newId('settlement');
    this.db.run(
      `INSERT INTO settlements (settlement_id, listing_id, ticket_id, sale_price_minor,
         organizer_minor, platform_minor, rights_holder_minor, seller_minor, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id,
      s.listingId,
      s.ticketId,
      s.split.total,
      s.split.organizer,
      s.split.platform,
      s.split.rightsHolder,
      s.split.seller,
      s.now,
    );
    return id;
  }

  settlementsForEvent(eventId: string) {
    return this.db.all<{
      settlement_id: string;
      sale_price_minor: number;
      organizer_minor: number;
      platform_minor: number;
      rights_holder_minor: number;
      seller_minor: number;
    }>(
      `SELECT s.* FROM settlements s JOIN tickets t ON t.ticket_id = s.ticket_id WHERE t.event_id = ?`,
      eventId,
    );
  }

  // ─ manifest ─

  /** Allocate the next sequence number and write the delta. Atomic within a tx. */
  appendDelta(eventId: string, kind: Delta['kind'], payload: object, now: EpochMs): number {
    return this.db.tx(() => {
      const changed = this.db.run(
        'UPDATE events SET manifest_sequence = manifest_sequence + 1 WHERE event_id = ?',
        eventId,
      );
      if (changed !== 1) throw new Error(`no such event ${eventId}`);
      const row = this.db.get<{ manifest_sequence: number }>(
        'SELECT manifest_sequence FROM events WHERE event_id = ?',
        eventId,
      );
      const seq = row?.manifest_sequence ?? 0;
      this.db.run(
        'INSERT INTO manifest_deltas (event_id, seq, kind, payload, created_at) VALUES (?,?,?,?,?)',
        eventId,
        seq,
        kind,
        JSON.stringify(payload),
        now,
      );
      return seq;
    });
  }

  deltasSince(eventId: string, since: number, limit = 500): Delta[] {
    const rows = this.db.all<{ seq: number; kind: Delta['kind']; payload: string }>(
      'SELECT seq, kind, payload FROM manifest_deltas WHERE event_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      eventId,
      since,
      limit,
    );
    return rows.map((r) => ({ seq: r.seq, ...(JSON.parse(r.payload) as object) }) as Delta);
  }

  /**
   * Build the manifest a scanner is keyed with at doors-open.
   *
   * `templateRef` is a pointer, not a template. The vault (M2) resolves it to
   * sealed bytes over a channel the application plane cannot use.
   */
  buildManifest(eventId: string, expiresAt: EpochMs, now: EpochMs): Manifest | undefined {
    const e = this.getEventRow(eventId);
    if (!e) return undefined;

    const rows = this.db.all<TicketRow>(
      `SELECT * FROM tickets WHERE event_id = ? AND state IN ('issued','listed','redeemed','revoked')`,
      eventId,
    );

    const entries = new Map<ReturnType<typeof toTicketId>, ManifestEntry>();
    for (const r of rows) {
      const entry: ManifestEntry = {
        ticketId: toTicketId(r.ticket_id),
        identityId: toIdentityId(r.owner_identity_id),
        tierId: toTierId(r.tier_id),
        templateRef: toTemplateRef(`tpl:${r.owner_identity_id}`),
        gates: [],
        admitFrom: epochMs(e.doors_open_at - 30 * 60_000),
        admitUntil: epochMs(e.ends_at),
        revoked: r.state === 'revoked',
        ...(r.seat !== null ? { seat: r.seat } : {}),
      };
      entries.set(entry.ticketId, entry);
    }

    return {
      eventId: toEventId(eventId),
      sequence: e.manifest_sequence,
      generatedAt: now,
      expiresAt,
      entries,
    };
  }

  // ─ attestations ─

  /** Insert, ignoring re-uploads of the same decision. Returns how many were new. */
  saveAttestations(eventId: string, batch: readonly EntryAttestation[], now: EpochMs): number {
    return this.db.tx(() => {
      let inserted = 0;
      for (const a of batch) {
        const changed = this.db.run(
          `INSERT OR IGNORE INTO entry_attestations (attestation_id, event_id, ticket_id, identity_id,
             lane, decided_at, outcome, code, match_score, manifest_sequence, offline, received_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          newId('attestation'),
          eventId,
          a.ticketId ?? null,
          a.identityId ?? null,
          a.lane,
          a.decidedAt,
          a.outcome,
          a.code,
          a.matchScore,
          a.manifestSequence,
          a.offline ? 1 : 0,
          now,
        );
        inserted += changed;
      }
      return inserted;
    });
  }

  attestationsForEvent(eventId: string): EntryAttestation[] {
    return this.db
      .all<{
        ticket_id: string | null;
        identity_id: string | null;
        lane: string;
        decided_at: number;
        outcome: EntryAttestation['outcome'];
        code: EntryAttestation['code'];
        match_score: number;
        manifest_sequence: number;
        offline: number;
      }>('SELECT * FROM entry_attestations WHERE event_id = ? ORDER BY decided_at', eventId)
      .map((r) => ({
        ticketId: toTicketId(r.ticket_id ?? 'unknown'),
        identityId: toIdentityId(r.identity_id ?? 'unknown'),
        lane: toLaneId(r.lane),
        decidedAt: epochMs(r.decided_at),
        outcome: r.outcome,
        code: r.code,
        matchScore: r.match_score,
        manifestSequence: r.manifest_sequence,
        offline: r.offline === 1,
      }));
  }

  // ─ idempotency ─

  getIdempotent(key: string): { request_hash: string; status_code: number; response_json: string } | undefined {
    return this.db.get('SELECT request_hash, status_code, response_json FROM idempotency_keys WHERE key = ?', key);
  }

  putIdempotent(key: string, endpoint: string, hash: string, status: number, body: string, now: EpochMs): void {
    this.db.run(
      `INSERT OR IGNORE INTO idempotency_keys (key, endpoint, request_hash, status_code, response_json, created_at)
       VALUES (?,?,?,?,?,?)`,
      key,
      endpoint,
      hash,
      status,
      body,
      now,
    );
  }
}

// ─── consent (appended for M2) ───────────────────────────────────────────────

export interface ConsentRow {
  consent_id: string;
  identity_id: string;
  purpose: string;
  text_version: string;
  granted_at: number | null;
  withdrawn_at: number | null;
  created_at: number;
}

/**
 * Consent repository methods.
 *
 * There is deliberately no `update` and no `delete` here. Consent is an
 * append-only ledger: a withdrawal is a new row. If a future change needs to
 * "fix" a consent record, the answer is another row, because the history is the
 * artefact a regulator asks for.
 */
export class ConsentRepo {
  constructor(private readonly db: Db) {}

  append(record: {
    id: string;
    identityId: string;
    purpose: string;
    textVersion: string;
    grantedAt?: number;
    withdrawnAt?: number;
    now: number;
  }): void {
    this.db.run(
      `INSERT INTO consents (consent_id, identity_id, purpose, text_version, granted_at, withdrawn_at, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      record.id,
      record.identityId,
      record.purpose,
      record.textVersion,
      record.grantedAt ?? null,
      record.withdrawnAt ?? null,
      record.now,
    );
  }

  forIdentity(identityId: string): ConsentRow[] {
    return this.db.all<ConsentRow>(
      'SELECT * FROM consents WHERE identity_id = ? ORDER BY created_at, rowid',
      identityId,
    );
  }
}
