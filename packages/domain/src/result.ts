/**
 * Rule evaluation returns a value, it does not throw.
 *
 * Every rejection carries a stable machine code and a message written for the
 * person who is about to be told no. Those two things end up in three places at
 * once — an API response, a support tool, and a screen a fan is reading while
 * standing in a queue — so they are part of the domain, not the transport layer.
 */

export type Verdict<Ok = void> =
  | ({ readonly ok: true } & (Ok extends void ? { readonly value?: undefined } : { readonly value: Ok }))
  | { readonly ok: false; readonly code: RejectionCode; readonly message: string; readonly detail?: Readonly<Record<string, unknown>> };

export type RejectionCode =
  // purchase
  | 'NOT_ENROLLED'
  | 'IDENTITY_BLOCKED'
  | 'PURCHASE_LIMIT_REACHED'
  | 'UNDER_MINIMUM_AGE'
  | 'SALE_NOT_OPEN'
  | 'SALE_CLOSED'
  | 'SOLD_OUT'
  | 'RISK_BLOCKED'
  // resale — listing
  | 'RESALE_DISABLED'
  | 'RESALE_WINDOW_NOT_OPEN'
  | 'RESALE_WINDOW_CLOSED'
  | 'COOLDOWN_ACTIVE'
  | 'PRICE_ABOVE_CEILING'
  | 'PRICE_BELOW_FLOOR'
  | 'RESALE_LIMIT_REACHED'
  | 'LISTING_LIMIT_REACHED'
  | 'TICKET_NOT_LISTABLE'
  // resale — purchase of a listing
  | 'LISTING_NOT_ACTIVE'
  | 'CANNOT_BUY_OWN_LISTING'
  | 'PRICE_CHANGED'
  // ticket lifecycle
  | 'ILLEGAL_TRANSITION'
  // entry
  | 'NOT_IN_MANIFEST'
  | 'CREDENTIAL_REVOKED'
  | 'ALREADY_ADMITTED'
  | 'TOO_EARLY'
  | 'TOO_LATE'
  | 'WRONG_GATE'
  // configuration
  | 'INVALID_POLICY';

export function ok(): Verdict<void>;
export function ok<T>(value: T): Verdict<T>;
export function ok<T>(value?: T): Verdict<T | void> {
  return { ok: true, value } as Verdict<T | void>;
}

export function reject(
  code: RejectionCode,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): Verdict<never> {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail };
}

/** For configuration errors, which are programmer errors rather than user outcomes. */
export class PolicyError extends Error {
  readonly code = 'INVALID_POLICY' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}
