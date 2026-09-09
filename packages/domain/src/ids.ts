/**
 * Branded identifiers.
 *
 * The important one is the separation between `PersonId`, `IdentityId` and
 * `TemplateRef` (architecture §03). The type system is the first line of defence:
 * a function that takes an `IdentityId` cannot be handed a `PersonId` by accident,
 * so a legal name cannot leak into the ticketing plane through a refactor.
 */

declare const IdBrand: unique symbol;

type Id<Tag extends string> = string & { readonly [IdBrand]: Tag };

/** The legal person. Identity service only. Never crosses a service boundary. */
export type PersonId = Id<'PersonId'>;

/** The opaque pseudonym. Safe to put on chain, in logs, and in a manifest. */
export type IdentityId = Id<'IdentityId'>;

/** Pointer into the biometric vault. Never returned by any API. */
export type TemplateRef = Id<'TemplateRef'>;

export type OrganizerId = Id<'OrganizerId'>;
export type EventId = Id<'EventId'>;
export type TierId = Id<'TierId'>;
export type TicketId = Id<'TicketId'>;
export type OrderId = Id<'OrderId'>;
export type ListingId = Id<'ListingId'>;
export type ScannerId = Id<'ScannerId'>;
export type LaneId = Id<'LaneId'>;
export type ConsentId = Id<'ConsentId'>;

const brand = <T extends string>(value: string, label: string): Id<T> => {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  return value as Id<T>;
};

export const personId = (v: string): PersonId => brand<'PersonId'>(v, 'personId');
export const identityId = (v: string): IdentityId => brand<'IdentityId'>(v, 'identityId');
export const templateRef = (v: string): TemplateRef => brand<'TemplateRef'>(v, 'templateRef');
export const organizerId = (v: string): OrganizerId => brand<'OrganizerId'>(v, 'organizerId');
export const eventId = (v: string): EventId => brand<'EventId'>(v, 'eventId');
export const tierId = (v: string): TierId => brand<'TierId'>(v, 'tierId');
export const ticketId = (v: string): TicketId => brand<'TicketId'>(v, 'ticketId');
export const orderId = (v: string): OrderId => brand<'OrderId'>(v, 'orderId');
export const listingId = (v: string): ListingId => brand<'ListingId'>(v, 'listingId');
export const scannerId = (v: string): ScannerId => brand<'ScannerId'>(v, 'scannerId');
export const laneId = (v: string): LaneId => brand<'LaneId'>(v, 'laneId');
export const consentId = (v: string): ConsentId => brand<'ConsentId'>(v, 'consentId');
