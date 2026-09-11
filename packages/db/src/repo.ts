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
  venue: string | null;
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
    ...(e.venue !== null ? { venue: e.venue } : {}),
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
  readonly outbox: OutboxRepo;
  readonly scanners: ScannerRepo;
  readonly organizers: OrganizerRepo;
  readonly catalogue: CatalogueRepo;

  constructor(readonly db: Db) {
    this.consents = new ConsentRepo(db);
    this.outbox = new OutboxRepo(db);
    this.scanners = new ScannerRepo(db);
    this.organizers = new OrganizerRepo(db);
    this.catalogue = new CatalogueRepo(db);
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

  // ─ recovery codes ─

  /**
   * Replace whatever live code this identity has with a new one.
   *
   * One transaction, because the partial unique index permits exactly one
   * unused row per identity: retiring the old one and inserting the new one
   * are not two facts that may briefly disagree.
   */
  issueRecoveryCode(id: IdentityId, codeHash: string, now: EpochMs): void {
    this.db.tx(() => {
      this.db.run('UPDATE recovery_codes SET used_at = ? WHERE identity_id = ? AND used_at IS NULL', now, id);
      this.db.run(
        'INSERT INTO recovery_codes (code_hash, identity_id, created_at, used_at) VALUES (?, ?, ?, NULL)',
        codeHash,
        id,
        now,
      );
    });
  }

  /**
   * Spend a recovery code.
   *
   * The `used_at IS NULL` in the UPDATE is the guard, not a preceding SELECT:
   * two devices racing the same code both see it unused, and only the one
   * whose UPDATE reports a changed row may act on it.
   */
  redeemRecoveryCode(codeHash: string, now: EpochMs): IdentityId | undefined {
    const row = this.db.get<{ identity_id: string }>(
      'SELECT identity_id FROM recovery_codes WHERE code_hash = ? AND used_at IS NULL',
      codeHash,
    );
    if (!row) return undefined;
    const changed = this.db.run(
      'UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL',
      now,
      codeHash,
    );
    return changed === 1 ? (row.identity_id as IdentityId) : undefined;
  }

  // ─ events ─

  createEvent(event: EventDef, now: EpochMs): void {
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO events (event_id, organizer_id, name, venue, capacity, sales_open_at, sales_close_at,
           doors_open_at, ends_at, max_tickets_per_identity, minimum_age, allow_reentry, policy_hash, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        event.id,
        event.organizerId,
        event.name,
        event.venue ?? null,
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

// ─── chain outbox (M3) ───────────────────────────────────────────────────────

export type OutboxKind = 'mint' | 'resale' | 'revoke';
export type OutboxState = 'pending' | 'submitted' | 'confirmed' | 'failed';

export interface OutboxRow {
  op_id: string;
  kind: OutboxKind;
  event_id: string;
  ref_id: string;
  payload: string;
  state: OutboxState;
  attempts: number;
  last_error: string | null;
  tx_hash: string | null;
  created_at: number;
}

/**
 * The outbox.
 *
 * Writing an intent to a table and draining it later, rather than calling the
 * chain inline, is what makes "the chain is never on the critical path" true
 * rather than aspirational. A sale completes by writing a row; if the sequencer
 * is down for an hour, the row waits.
 *
 * The unique index on (kind, ref_id) means a retry cannot enqueue a second mint
 * for the same ticket, which would put two tokens in circulation for one seat.
 */
export class OutboxRepo {
  constructor(private readonly db: Db) {}

  enqueue(op: { kind: OutboxKind; eventId: string; refId: string; payload: object; now: number }): string | null {
    const id = newId('attestation').replace('att_', 'cop_');
    const changed = this.db.run(
      `INSERT OR IGNORE INTO chain_outbox (op_id, kind, event_id, ref_id, payload, state, created_at)
       VALUES (?,?,?,?,?,'pending',?)`,
      id,
      op.kind,
      op.eventId,
      op.refId,
      JSON.stringify(op.payload),
      op.now,
    );
    // Already enqueued. Not an error — it is the retry working as intended.
    return changed === 1 ? id : null;
  }

  /** Oldest first, so a stuck batch does not starve everything behind it. */
  claimPending(kind: OutboxKind, limit: number): OutboxRow[] {
    return this.db.all<OutboxRow>(
      `SELECT * FROM chain_outbox WHERE kind = ? AND state IN ('pending','failed') ORDER BY created_at, rowid LIMIT ?`,
      kind,
      limit,
    );
  }

  markConfirmed(opId: string, txHash: string, now: number): void {
    this.db.run(
      `UPDATE chain_outbox SET state = 'confirmed', tx_hash = ?, confirmed_at = ?, last_error = NULL WHERE op_id = ?`,
      txHash,
      now,
      opId,
    );
  }

  markFailed(opId: string, error: string): void {
    this.db.run(
      `UPDATE chain_outbox SET state = 'failed', attempts = attempts + 1, last_error = ? WHERE op_id = ?`,
      error.slice(0, 500),
      opId,
    );
  }

  status(): { pending: number; confirmed: number; failed: number; oldestPendingAt: number | null } {
    const counts = this.db.all<{ state: OutboxState; n: number }>(
      'SELECT state, COUNT(*) AS n FROM chain_outbox GROUP BY state',
    );
    const by = (s: OutboxState) => counts.find((c) => c.state === s)?.n ?? 0;
    const oldest = this.db.get<{ created_at: number }>(
      `SELECT created_at FROM chain_outbox WHERE state IN ('pending','failed') ORDER BY created_at LIMIT 1`,
    );
    return {
      pending: by('pending') + by('failed'),
      confirmed: by('confirmed'),
      failed: by('failed'),
      oldestPendingAt: oldest?.created_at ?? null,
    };
  }

  /** Chain state lives on the ticket too, so a support tool can see it in one place. */
  setTicketMintState(ticketId: string, state: OutboxState, tokenId: string | null): void {
    this.db.run('UPDATE tickets SET mint_state = ?, token_id = ? WHERE ticket_id = ?', state, tokenId, ticketId);
  }

  /**
   * The ERC-721 a ticket became, or nothing if its mint has not confirmed.
   *
   * Its own reader rather than a field on `Ticket`, because a ticket in the
   * domain is an entitlement to enter and knows nothing about chains — and
   * should keep knowing nothing, so that turning the chain off changes no type.
   * The one caller is the resale drain, which cannot transfer a token that does
   * not exist yet.
   */
  tokenIdFor(ticketId: string): string | undefined {
    const row = this.db.get<{ token_id: string | null }>('SELECT token_id FROM tickets WHERE ticket_id = ?', ticketId);
    return row?.token_id ?? undefined;
  }

  setEventChainAddress(eventId: string, address: string): void {
    this.db.run('UPDATE events SET chain_address = ? WHERE event_id = ?', address, eventId);
  }
}

// ─── scanners (M4) ───────────────────────────────────────────────────────────

export interface ScannerRow {
  scanner_id: string;
  event_id: string | null;
  lane: string;
  gate_group: string;
  public_key_pem: string;
  registered_at: number;
  last_seen_at: number | null;
}

export class ScannerRepo {
  constructor(private readonly db: Db) {}

  register(s: {
    scannerId: string;
    eventId: string;
    lane: string;
    gateGroup: string;
    publicKeyPem: string;
    now: number;
  }): void {
    // Re-registering replaces the key. A device that was wiped and re-provisioned
    // is the same lane with a new keypair, and refusing that would strand it.
    this.db.run(
      `INSERT INTO scanners (scanner_id, event_id, lane, gate_group, public_key_pem, registered_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(scanner_id) DO UPDATE SET
         event_id = excluded.event_id, lane = excluded.lane, gate_group = excluded.gate_group,
         public_key_pem = excluded.public_key_pem, registered_at = excluded.registered_at`,
      s.scannerId,
      s.eventId,
      s.lane,
      s.gateGroup,
      s.publicKeyPem,
      s.now,
    );
  }

  get(scannerId: string): ScannerRow | undefined {
    return this.db.get<ScannerRow>('SELECT * FROM scanners WHERE scanner_id = ?', scannerId);
  }

  forEvent(eventId: string): ScannerRow[] {
    return this.db.all<ScannerRow>('SELECT * FROM scanners WHERE event_id = ? ORDER BY lane', eventId);
  }

  touch(scannerId: string, now: number): void {
    this.db.run('UPDATE scanners SET last_seen_at = ? WHERE scanner_id = ?', now, scannerId);
  }

  /** Credentials for a manifest: every ticket that could open a gate tonight. */
  credentialsForEvent(eventId: string, doorsOpenAt: number, endsAt: number) {
    return this.db
      .all<{ ticket_id: string; owner_identity_id: string; tier_id: string; seat: string | null; state: string }>(
        `SELECT ticket_id, owner_identity_id, tier_id, seat, state FROM tickets
         WHERE event_id = ? AND state IN ('issued','listed','redeemed','revoked') ORDER BY created_at`,
        eventId,
      )
      .map((t) => ({
        ticketId: t.ticket_id,
        identityId: t.owner_identity_id,
        tierId: t.tier_id,
        ...(t.seat !== null ? { seat: t.seat } : {}),
        gates: [] as string[],
        admitFrom: doorsOpenAt - 30 * 60_000,
        admitUntil: endsAt,
        revoked: t.state === 'revoked',
      }));
  }
}

// ─── organizers and API keys (M6) ────────────────────────────────────────────

export interface ApiKeyRow {
  key_id: string;
  organizer_id: string;
  name: string;
  prefix: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export type Scope = 'events:write' | 'events:read' | 'analytics:read' | 'settlement:read' | 'scanners:write';

export const ALL_SCOPES: readonly Scope[] = [
  'events:write',
  'events:read',
  'analytics:read',
  'settlement:read',
  'scanners:write',
];

/**
 * Organizer accounts and their credentials.
 *
 * The security property that matters here is tenancy: an organizer must never
 * be able to read another organizer's sales, attendance or settlement. That is
 * enforced by every read taking an organizerId and every route checking
 * ownership — not by the caller remembering to filter.
 */
export class OrganizerRepo {
  constructor(private readonly db: Db) {}

  create(o: { id: string; name: string; contactEmail?: string; now: number }): void {
    this.db.run(
      'INSERT INTO organizers (organizer_id, name, contact_email, state, created_at) VALUES (?,?,?,?,?)',
      o.id,
      o.name,
      o.contactEmail ?? null,
      'active',
      o.now,
    );
  }

  get(id: string) {
    return this.db.get<{ organizer_id: string; name: string; contact_email: string | null; state: string; created_at: number }>(
      'SELECT * FROM organizers WHERE organizer_id = ?',
      id,
    );
  }

  /** Store only the hash. A stolen table must not yield a working key. */
  addKey(k: {
    keyId: string;
    organizerId: string;
    name: string;
    keyHash: string;
    prefix: string;
    scopes: readonly string[];
    now: number;
  }): void {
    this.db.run(
      'INSERT INTO api_keys (key_id, organizer_id, name, key_hash, prefix, scopes, created_at) VALUES (?,?,?,?,?,?,?)',
      k.keyId,
      k.organizerId,
      k.name,
      k.keyHash,
      k.prefix,
      k.scopes.join(','),
      k.now,
    );
  }

  findByHash(hash: string): ApiKeyRow | undefined {
    return this.db.get<ApiKeyRow>(
      'SELECT key_id, organizer_id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys WHERE key_hash = ?',
      hash,
    );
  }

  keysFor(organizerId: string): ApiKeyRow[] {
    return this.db.all<ApiKeyRow>(
      'SELECT key_id, organizer_id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys WHERE organizer_id = ? ORDER BY created_at',
      organizerId,
    );
  }

  revokeKey(organizerId: string, keyId: string, now: number): boolean {
    return (
      this.db.run(
        'UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND organizer_id = ? AND revoked_at IS NULL',
        now,
        keyId,
        organizerId,
      ) === 1
    );
  }

  touchKey(keyId: string, now: number): void {
    this.db.run('UPDATE api_keys SET last_used_at = ? WHERE key_id = ?', now, keyId);
  }

  /** Ownership check. Every organizer-scoped route calls this before anything else. */
  ownsEvent(organizerId: string, eventId: string): boolean {
    return (
      this.db.get('SELECT 1 FROM events WHERE event_id = ? AND organizer_id = ?', eventId, organizerId) !== undefined
    );
  }

  eventsFor(organizerId: string) {
    return this.db.all<{ event_id: string; name: string; capacity: number; doors_open_at: number; created_at: number }>(
      'SELECT event_id, name, capacity, doors_open_at, created_at FROM events WHERE organizer_id = ? ORDER BY doors_open_at DESC',
      organizerId,
    );
  }
}

// ─── public catalogue (discovery) ────────────────────────────────────────────

export interface CatalogueRow {
  event_id: string;
  name: string;
  venue: string | null;
  organizer_name: string;
  capacity: number;
  sales_open_at: number;
  sales_close_at: number;
  doors_open_at: number;
  ends_at: number;
  min_face_value: number;
  allocation: number;
  sold: number;
  held: number;
  any_capped: number;
}

/**
 * The public catalogue.
 *
 * Aggregated in SQL rather than by loading every event and its tiers, because
 * this is the one endpoint a bored crawler will hit hardest and it must not
 * turn into N+1 queries against the same tables an onsale is writing to.
 *
 * Note what is NOT selected: no commission split, no manifest sequence, no
 * per-tier sold counts. A public row cannot leak what it never loads.
 */
export class CatalogueRepo {
  constructor(private readonly db: Db) {}

  /**
   * What is on sale, optionally narrowed by a search term.
   *
   * The filter is applied in SQL rather than by the caller after paging,
   * because filtering a page is not the same thing as searching a catalogue:
   * with the page limit at 100, a client-side filter would silently stop
   * finding events the moment there were more than that.
   *
   * LIKE with the term escaped, not FTS. Ten events do not need an index, and
   * a real one should arrive with the load that justifies it.
   */
  onSale(now: number, limit = 50, offset = 0, search = ''): CatalogueRow[] {
    const term = search.trim().toLowerCase();
    if (term) {
      // The wildcards are escaped, so a search for "100%" looks for that
      // rather than matching everything.
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return this.db.all<CatalogueRow>(
        `SELECT e.event_id, e.name, e.venue, o.name AS organizer_name, e.capacity,
                e.sales_open_at, e.sales_close_at, e.doors_open_at, e.ends_at,
                MIN(t.face_value)                              AS min_face_value,
                COALESCE(SUM(t.allocation), 0)                 AS allocation,
                COALESCE(SUM(t.sold), 0)                       AS sold,
                COALESCE(SUM(t.held), 0)                       AS held,
                MAX(CASE WHEN t.resale_mode = 'capped' THEN 1 ELSE 0 END) AS any_capped
         FROM events e
         JOIN organizers o ON o.organizer_id = e.organizer_id
         JOIN tiers t      ON t.event_id = e.event_id
         WHERE e.sales_open_at <= ? AND e.sales_close_at > ? AND e.ends_at > ?
           AND ( LOWER(e.name) LIKE ? ESCAPE '\\'
              OR LOWER(COALESCE(e.venue, '')) LIKE ? ESCAPE '\\'
              OR LOWER(o.name) LIKE ? ESCAPE '\\' )
         GROUP BY e.event_id
         ORDER BY e.doors_open_at
         LIMIT ? OFFSET ?`,
        now, now, now, like, like, like, limit, offset,
      );
    }
    return this.onSaleAll(now, limit, offset);
  }

  private onSaleAll(now: number, limit: number, offset: number): CatalogueRow[] {
    return this.db.all<CatalogueRow>(
      `SELECT e.event_id, e.name, e.venue, o.name AS organizer_name, e.capacity,
              e.sales_open_at, e.sales_close_at, e.doors_open_at, e.ends_at,
              MIN(t.face_value)                              AS min_face_value,
              COALESCE(SUM(t.allocation), 0)                 AS allocation,
              COALESCE(SUM(t.sold), 0)                       AS sold,
              COALESCE(SUM(t.held), 0)                       AS held,
              MAX(CASE WHEN t.resale_mode = 'capped' THEN 1 ELSE 0 END) AS any_capped
       FROM events e
       JOIN organizers o ON o.organizer_id = e.organizer_id
       JOIN tiers t      ON t.event_id = e.event_id
       WHERE e.sales_open_at <= ? AND e.sales_close_at > ? AND e.ends_at > ?
       GROUP BY e.event_id
       ORDER BY e.doors_open_at
       LIMIT ? OFFSET ?`,
      now,
      now,
      now,
      limit,
      offset,
    );
  }

  countOnSale(now: number): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events
       WHERE sales_open_at <= ? AND sales_close_at > ? AND ends_at > ?`,
      now,
      now,
      now,
    );
    return row?.n ?? 0;
  }
}
