/**
 * @rexell/domain — the rules, with no I/O.
 *
 * Nothing in this package reads a clock, opens a socket, or touches a database.
 * Everything that changes money or admits a person is a pure function over
 * explicit inputs, so it can be tested at an exact instant and run identically in
 * an API process and on a scanner with no network.
 */

export * from './money.js';
export * from './ids.js';
export * from './time.js';
export * from './result.js';
export * from './consent.js';
export * from './availability.js';
export * from './event.js';
export * from './ticket.js';
export * from './splits.js';
export * from './purchase.js';
export * from './resale.js';
export * from './manifest.js';
export * from './entry.js';
