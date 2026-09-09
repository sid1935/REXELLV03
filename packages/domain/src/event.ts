import type { Bps, Minor } from './money.js';
import { BPS_DENOMINATOR, applyBps, assertBps } from './money.js';
import type { EventId, OrganizerId, TierId } from './ids.js';
import { PolicyError } from './result.js';
import type { EpochMs } from './time.js';

/**
 * Two modes, and deliberately no third one.
 *
 * `bound`  — transfer reverts for every caller. The entitlement dies with its owner.
 * `capped` — transfer is permitted only through the resale controller, which is
 *            where the ceiling, window and splits are enforced.
 *
 * There is no `open` mode. A freely transferable ticket can reach a general NFT
 * marketplace, which is how "NFT ticketing" leaks straight back into scalping.
 */
export type ResaleMode = 'bound' | 'capped';

/**
 * Where the money from a resale goes. Everything not allocated here is the
 * seller's — see `computeSplits`. The seller is not given a bps figure precisely
 * so that the split always sums exactly.
 */
export interface SplitTable {
  readonly organizerBps: Bps;
  readonly platformBps: Bps;
  readonly rightsHolderBps: Bps;
}

export interface ResalePolicy {
  readonly mode: ResaleMode;
  /** Ceiling as a proportion of face value. 11_000 = 110%. Ignored when mode is `bound`. */
  readonly maxPriceBps: Bps;
  /** Floor, to stop wash-trading a ticket to a colluding account for nothing. */
  readonly minPriceBps: Bps;
  readonly opensAt: EpochMs;
  readonly closesAt: EpochMs;
  /** Time a buyer must hold a ticket before relisting it. Defeats buy-and-flip bots. */
  readonly cooldownMs: number;
  readonly maxResalesPerTicket: number;
  readonly maxActiveListingsPerIdentity: number;
  readonly splits: SplitTable;
}

export interface TicketTier {
  readonly id: TierId;
  readonly eventId: EventId;
  readonly name: string;
  readonly faceValue: Minor;
  readonly allocation: number;
  readonly resale: ResalePolicy;
}

export interface EventDef {
  readonly id: EventId;
  readonly organizerId: OrganizerId;
  readonly name: string;
  readonly capacity: number;
  readonly salesOpenAt: EpochMs;
  readonly salesCloseAt: EpochMs;
  readonly doorsOpenAt: EpochMs;
  readonly endsAt: EpochMs;
  readonly tiers: readonly TicketTier[];
  readonly maxTicketsPerIdentity: number;
  readonly minimumAge?: number;
  /** Whether a redeemed ticket may be scanned again (pass-outs at a festival). */
  readonly allowReentry: boolean;
}

export const NO_RESALE: ResalePolicy = Object.freeze({
  mode: 'bound',
  maxPriceBps: BPS_DENOMINATOR,
  minPriceBps: BPS_DENOMINATOR,
  opensAt: 0 as EpochMs,
  closesAt: 0 as EpochMs,
  cooldownMs: 0,
  maxResalesPerTicket: 0,
  maxActiveListingsPerIdentity: 0,
  splits: Object.freeze({ organizerBps: 0, platformBps: 0, rightsHolderBps: 0 }),
});

export function totalAllocatedBps(splits: SplitTable): Bps {
  return splits.organizerBps + splits.platformBps + splits.rightsHolderBps;
}

/**
 * Validated once, at event creation, and then anchored. An organizer must not be
 * able to quietly change resale terms after inventory has sold — the policy hash
 * written on chain is derived from exactly this object.
 */
export function validateResalePolicy(policy: ResalePolicy): void {
  assertBps(policy.maxPriceBps, 'maxPriceBps');
  assertBps(policy.minPriceBps, 'minPriceBps');
  assertBps(policy.splits.organizerBps, 'splits.organizerBps');
  assertBps(policy.splits.platformBps, 'splits.platformBps');
  assertBps(policy.splits.rightsHolderBps, 'splits.rightsHolderBps');

  const allocated = totalAllocatedBps(policy.splits);
  if (allocated > BPS_DENOMINATOR) {
    throw new PolicyError(
      `splits allocate ${allocated} bps, which is more than 100%; the seller would owe money on their own sale`,
    );
  }

  if (policy.mode === 'bound') {
    // A bound policy is inert. Nothing below applies, and validating it would
    // reject the perfectly reasonable NO_RESALE zero values.
    return;
  }

  if (policy.maxPriceBps < BPS_DENOMINATOR) {
    throw new PolicyError(
      `maxPriceBps ${policy.maxPriceBps} is below face value; use mode 'bound' to stop resale rather than a ceiling below 100%`,
    );
  }
  if (policy.minPriceBps > policy.maxPriceBps) {
    throw new PolicyError(`minPriceBps ${policy.minPriceBps} is above maxPriceBps ${policy.maxPriceBps}`);
  }
  if (policy.closesAt <= policy.opensAt) {
    throw new PolicyError(`resale window closes at ${policy.closesAt}, at or before it opens at ${policy.opensAt}`);
  }
  if (!Number.isInteger(policy.cooldownMs) || policy.cooldownMs < 0) {
    throw new PolicyError(`cooldownMs must be a non-negative integer, got ${policy.cooldownMs}`);
  }
  if (!Number.isInteger(policy.maxResalesPerTicket) || policy.maxResalesPerTicket < 0) {
    throw new PolicyError(`maxResalesPerTicket must be a non-negative integer, got ${policy.maxResalesPerTicket}`);
  }
  if (!Number.isInteger(policy.maxActiveListingsPerIdentity) || policy.maxActiveListingsPerIdentity < 0) {
    throw new PolicyError(
      `maxActiveListingsPerIdentity must be a non-negative integer, got ${policy.maxActiveListingsPerIdentity}`,
    );
  }
}

export function validateEvent(event: EventDef): void {
  if (event.capacity <= 0) throw new PolicyError(`capacity must be positive, got ${event.capacity}`);
  if (event.tiers.length === 0) throw new PolicyError(`event ${event.id} has no tiers`);
  if (event.salesCloseAt <= event.salesOpenAt) {
    throw new PolicyError(`sales close at ${event.salesCloseAt}, at or before they open at ${event.salesOpenAt}`);
  }
  if (event.endsAt <= event.doorsOpenAt) {
    throw new PolicyError(`event ends at ${event.endsAt}, at or before doors open at ${event.doorsOpenAt}`);
  }
  if (event.maxTicketsPerIdentity <= 0) {
    throw new PolicyError(`maxTicketsPerIdentity must be positive, got ${event.maxTicketsPerIdentity}`);
  }

  const allocated = event.tiers.reduce((n, t) => n + t.allocation, 0);
  if (allocated > event.capacity) {
    throw new PolicyError(
      `tiers allocate ${allocated} tickets against a capacity of ${event.capacity}; overselling is a contract-level invariant, not a warning`,
    );
  }

  const seen = new Set<string>();
  for (const tier of event.tiers) {
    if (seen.has(tier.id)) throw new PolicyError(`duplicate tier id ${tier.id}`);
    seen.add(tier.id);
    if (tier.allocation <= 0) throw new PolicyError(`tier ${tier.id} has a non-positive allocation`);
    validateResalePolicy(tier.resale);
  }
}

/** The highest price this tier may be resold at, in money. */
export function resaleCeiling(tier: TicketTier): Minor {
  return applyBps(tier.faceValue, tier.resale.maxPriceBps);
}

/** The lowest price this tier may be resold at, in money. */
export function resaleFloor(tier: TicketTier): Minor {
  return applyBps(tier.faceValue, tier.resale.minPriceBps);
}
