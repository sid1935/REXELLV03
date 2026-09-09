/**
 * Money in integer minor units (paise, cents). There is no float anywhere in the
 * money path and there never will be: a 0.1 + 0.2 problem in a split calculation
 * is a settlement dispute with an organizer.
 *
 * Basis points are used for every proportion. 10_000 bps = 100%.
 */

declare const MinorBrand: unique symbol;

/** An amount in minor units. Always an integer, always >= 0. */
export type Minor = number & { readonly [MinorBrand]: 'Minor' };

/** Basis points. 10_000 = 100%. */
export type Bps = number;

export const BPS_DENOMINATOR = 10_000 as const;

/** Largest amount we accept. Keeps every intermediate product inside Number.MAX_SAFE_INTEGER. */
export const MAX_MINOR = 1_000_000_000_000 as const; // 10 billion rupees in paise

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function minor(value: number): Minor {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`amount must be an integer number of minor units, got ${value}`);
  }
  if (value < 0) {
    throw new MoneyError(`amount must not be negative, got ${value}`);
  }
  if (value > MAX_MINOR) {
    throw new MoneyError(`amount ${value} exceeds MAX_MINOR ${MAX_MINOR}`);
  }
  return value as Minor;
}

export const ZERO: Minor = 0 as Minor;

export function add(a: Minor, b: Minor): Minor {
  return minor(a + b);
}

/** Saturating subtraction is a bug factory, so this throws instead. */
export function sub(a: Minor, b: Minor): Minor {
  if (b > a) {
    throw new MoneyError(`subtracting ${b} from ${a} would produce a negative amount`);
  }
  return minor(a - b);
}

export function mul(a: Minor, factor: number): Minor {
  if (!Number.isInteger(factor) || factor < 0) {
    throw new MoneyError(`factor must be a non-negative integer, got ${factor}`);
  }
  return minor(a * factor);
}

export function sum(amounts: readonly Minor[]): Minor {
  return amounts.reduce<Minor>((acc, n) => add(acc, n), ZERO);
}

export function isBps(value: number): value is Bps {
  return Number.isInteger(value) && value >= 0;
}

export function assertBps(value: number, label: string): Bps {
  if (!isBps(value)) {
    throw new MoneyError(`${label} must be a non-negative integer basis-point value, got ${value}`);
  }
  return value;
}

/**
 * Apply a basis-point proportion, rounding DOWN.
 *
 * Rounding down is deliberate and load-bearing: in `computeSplits` every party
 * except the seller is floored, and the seller takes the remainder. That makes
 * the split sum exactly, with no dust and no rounding gain for the platform.
 */
export function applyBps(amount: Minor, bps: Bps): Minor {
  assertBps(bps, 'bps');
  return minor(Math.floor((amount * bps) / BPS_DENOMINATOR));
}

/** Format for display and logs only. Never parse this back into money. */
export function formatMinor(amount: Minor, opts: { symbol?: string; exponent?: number } = {}): string {
  const exponent = opts.exponent ?? 2;
  const divisor = 10 ** exponent;
  const whole = Math.floor(amount / divisor);
  const frac = amount % divisor;
  const symbol = opts.symbol ?? '';
  return `${symbol}${whole.toLocaleString('en-IN')}.${String(frac).padStart(exponent, '0')}`;
}
