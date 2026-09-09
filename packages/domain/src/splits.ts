import type { Minor } from './money.js';
import { BPS_DENOMINATOR, applyBps, sub, sum } from './money.js';
import type { SplitTable } from './event.js';
import { totalAllocatedBps } from './event.js';
import { PolicyError } from './result.js';

export interface SplitResult {
  readonly organizer: Minor;
  readonly platform: Minor;
  readonly rightsHolder: Minor;
  /** Whatever is left. The seller absorbs every rounding remainder, upward. */
  readonly seller: Minor;
  readonly total: Minor;
}

/**
 * Split a resale price between the parties.
 *
 * The invariant this function exists to guarantee is:
 *
 *     organizer + platform + rightsHolder + seller === salePrice
 *
 * exactly, for every input, with no dust left over and no party silently gaining
 * a paisa from rounding. It achieves that by flooring the three fixed shares and
 * giving the remainder to the seller, which means rounding error always favours
 * the person selling rather than the platform collecting.
 *
 * That direction is deliberate. A platform that rounds in its own favour on every
 * transaction is a platform that will eventually have to explain itself to an
 * organizer holding a spreadsheet.
 */
export function computeSplits(salePrice: Minor, splits: SplitTable): SplitResult {
  const allocated = totalAllocatedBps(splits);
  if (allocated > BPS_DENOMINATOR) {
    throw new PolicyError(`splits allocate ${allocated} bps, more than 100%`);
  }

  const organizer = applyBps(salePrice, splits.organizerBps);
  const platform = applyBps(salePrice, splits.platformBps);
  const rightsHolder = applyBps(salePrice, splits.rightsHolderBps);
  const seller = sub(salePrice, sum([organizer, platform, rightsHolder]));

  return { organizer, platform, rightsHolder, seller, total: salePrice };
}

/** Sanity check usable as an assertion in tests and at a settlement boundary. */
export function splitsBalance(result: SplitResult): boolean {
  return sum([result.organizer, result.platform, result.rightsHolder, result.seller]) === result.total;
}
