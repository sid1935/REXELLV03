import type { RejectionCode } from '@rexell/domain';

/**
 * Domain rejection → HTTP status.
 *
 * The mapping lives here rather than at each call site so that one code always
 * produces one status. The distinction that matters:
 *
 *   403 — you are not allowed to do this
 *   409 — the world is not in a state where this is possible right now
 *   422 — what you sent is not acceptable for this resource
 *
 * "Sold out" is a 409, not a 404 and not a 400: the request was well-formed and
 * the caller was entitled to make it, the inventory simply went.
 */
const STATUS: Readonly<Record<RejectionCode, number>> = {
  NOT_ENROLLED: 403,
  IDENTITY_BLOCKED: 403,
  RISK_BLOCKED: 403,
  UNDER_MINIMUM_AGE: 403,

  PURCHASE_LIMIT_REACHED: 409,
  SALE_NOT_OPEN: 409,
  SALE_CLOSED: 409,
  SOLD_OUT: 409,

  RESALE_DISABLED: 409,
  RESALE_WINDOW_NOT_OPEN: 409,
  RESALE_WINDOW_CLOSED: 409,
  COOLDOWN_ACTIVE: 409,
  RESALE_LIMIT_REACHED: 409,
  LISTING_LIMIT_REACHED: 409,
  TICKET_NOT_LISTABLE: 409,
  LISTING_NOT_ACTIVE: 409,
  ILLEGAL_TRANSITION: 409,

  PRICE_ABOVE_CEILING: 422,
  PRICE_BELOW_FLOOR: 422,
  PRICE_CHANGED: 422,
  CANNOT_BUY_OWN_LISTING: 422,

  NOT_IN_MANIFEST: 404,
  CREDENTIAL_REVOKED: 409,
  ALREADY_ADMITTED: 409,
  TOO_EARLY: 409,
  TOO_LATE: 409,
  WRONG_GATE: 409,

  INVALID_POLICY: 400,
};

export function statusFor(code: RejectionCode): number {
  return STATUS[code] ?? 400;
}

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly detail?: unknown };
}

export function errorBody(code: string, message: string, detail?: unknown): ApiErrorBody {
  return { error: detail === undefined ? { code, message } : { code, message, detail } };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string, id: string) => new HttpError(404, 'NOT_FOUND', `No ${what} with id ${id}.`);
export const badRequest = (message: string, detail?: unknown) =>
  new HttpError(400, 'BAD_REQUEST', message, detail);
