import type { EventId, IdentityId, TicketId, TierId } from './ids.js';
import type { EpochMs } from './time.js';
import type { Verdict } from './result.js';
import { ok, reject } from './result.js';

/**
 * Ticket lifecycle.
 *
 *   held ──pay──► issued ──list──► listed ──sell──► issued (new owner)
 *                   │                 │
 *                   │                 └──unlist──► issued
 *                   ├──scan──► redeemed
 *                   ├──refund──► refunded
 *                   └──revoke──► revoked
 *
 * Note the deviation from the sketch in the architecture document: there is no
 * `transferred` state. Transfer is an *event* that changes the owner and returns
 * the ticket to `issued`, because a transferred ticket is in every respect an
 * ordinary valid ticket belonging to somebody else. Modelling it as a state would
 * mean every entry check had to accept two states meaning "valid".
 */
export type TicketState = 'held' | 'issued' | 'listed' | 'redeemed' | 'refunded' | 'revoked';

export type TicketEvent =
  | { readonly kind: 'pay' }
  | { readonly kind: 'expireHold' }
  | { readonly kind: 'list' }
  | { readonly kind: 'unlist' }
  | { readonly kind: 'sell'; readonly toIdentity: IdentityId; readonly at: EpochMs }
  | { readonly kind: 'redeem'; readonly at: EpochMs }
  | { readonly kind: 'refund' }
  | { readonly kind: 'revoke'; readonly reason: string };

export interface Ticket {
  readonly id: TicketId;
  readonly eventId: EventId;
  readonly tierId: TierId;
  readonly ownerIdentityId: IdentityId;
  readonly state: TicketState;
  /** When the current owner acquired it. Resets on every sale — the cooldown clock. */
  readonly acquiredAt: EpochMs;
  /** How many times this ticket has changed hands on the secondary market. */
  readonly resaleCount: number;
  readonly redeemedAt?: EpochMs;
  readonly revokedReason?: string;
  readonly seat?: string;
}

const TRANSITIONS: Readonly<Record<TicketState, readonly TicketEvent['kind'][]>> = Object.freeze({
  held: ['pay', 'expireHold'],
  issued: ['list', 'redeem', 'refund', 'revoke'],
  listed: ['unlist', 'sell', 'revoke'],
  redeemed: ['revoke'],
  refunded: [],
  revoked: [],
});

export function canApply(state: TicketState, kind: TicketEvent['kind']): boolean {
  return TRANSITIONS[state].includes(kind);
}

/** A ticket that will currently open a gate. `listed` counts: it is still yours until it sells. */
export function isValidForEntry(state: TicketState): boolean {
  return state === 'issued' || state === 'listed';
}

export function applyTicketEvent(ticket: Ticket, event: TicketEvent): Verdict<Ticket> {
  if (!canApply(ticket.state, event.kind)) {
    return reject(
      'ILLEGAL_TRANSITION',
      `a ticket in state '${ticket.state}' cannot handle '${event.kind}'`,
      { ticketId: ticket.id, from: ticket.state, event: event.kind },
    );
  }

  switch (event.kind) {
    case 'pay':
      return ok({ ...ticket, state: 'issued' });
    case 'expireHold':
      return ok({ ...ticket, state: 'refunded' });
    case 'list':
      return ok({ ...ticket, state: 'listed' });
    case 'unlist':
      return ok({ ...ticket, state: 'issued' });
    case 'sell':
      return ok({
        ...ticket,
        state: 'issued',
        ownerIdentityId: event.toIdentity,
        acquiredAt: event.at,
        resaleCount: ticket.resaleCount + 1,
      });
    case 'redeem':
      return ok({ ...ticket, state: 'redeemed', redeemedAt: event.at });
    case 'refund':
      return ok({ ...ticket, state: 'refunded' });
    case 'revoke':
      return ok({ ...ticket, state: 'revoked', revokedReason: event.reason });
  }
}
