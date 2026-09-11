/**
 * Remove an event and everything that hangs off it.
 *
 *   REXELL_DB=/var/lib/rexell/rexell.sqlite npm run remove:event -- evt_id
 *
 * There is no API route that deletes an event, and that is deliberate: an
 * organizer must not be able to make a sold ticket disappear. This is an
 * operator's tool for a catalogue mistake — an event published by the seed
 * that should not have been — and it says out loud what it is about to
 * destroy before it does it.
 *
 * Order matters. SQLite enforces the foreign keys, so children go before
 * parents: settlements and listings before tickets, tickets and orders and
 * holds before tiers, everything before the event. One transaction, so a
 * failure part way through leaves the database exactly as it was rather than
 * half a catalogue.
 *
 * ⚠ This deletes settlements, which in a real deployment are ledger rows that
 * somebody may be owed money against. It refuses unless --force is passed once
 * it finds any, so removing a genuinely traded event has to be a decision
 * rather than a typo.
 */
import { DatabaseSync } from 'node:sqlite';

const eventId = process.argv[2];
const force = process.argv.includes('--force');
const path = process.env['REXELL_DB'] ?? 'rexell.sqlite';

if (!eventId || eventId.startsWith('--')) {
  console.error('\n  usage: npm run remove:event -- <event-id> [--force]\n');
  process.exit(2);
}

const db = new DatabaseSync(path);
try {
  db.exec('PRAGMA foreign_keys = ON');

  const event = db.prepare('SELECT event_id, name FROM events WHERE event_id = ?').get(eventId) as
    | { event_id: string; name: string }
    | undefined;
  if (!event) {
    console.error(`\n  No event ${eventId} in ${path}.\n`);
    process.exit(1);
  }

  /** Children first, parents last. */
  const STEPS: Array<[string, string]> = [
    ['settlements', 'DELETE FROM settlements WHERE ticket_id IN (SELECT ticket_id FROM tickets WHERE event_id = ?)'],
    ['listings', 'DELETE FROM listings WHERE ticket_id IN (SELECT ticket_id FROM tickets WHERE event_id = ?)'],
    ['entry_attestations', 'DELETE FROM entry_attestations WHERE event_id = ?'],
    ['manifest_deltas', 'DELETE FROM manifest_deltas WHERE event_id = ?'],
    ['chain_outbox', 'DELETE FROM chain_outbox WHERE event_id = ?'],
    ['scanners', 'DELETE FROM scanners WHERE event_id = ?'],
    ['tickets', 'DELETE FROM tickets WHERE event_id = ?'],
    ['orders', 'DELETE FROM orders WHERE event_id = ?'],
    ['holds', 'DELETE FROM holds WHERE tier_id IN (SELECT tier_id FROM tiers WHERE event_id = ?)'],
    ['tiers', 'DELETE FROM tiers WHERE event_id = ?'],
    ['events', 'DELETE FROM events WHERE event_id = ?'],
  ];

  const settlements = (
    db
      .prepare('SELECT count(*) AS c FROM settlements WHERE ticket_id IN (SELECT ticket_id FROM tickets WHERE event_id = ?)')
      .get(eventId) as { c: number }
  ).c;

  console.log(`\n  ${event.name}  (${eventId})`);
  console.log(`  ${path}\n`);

  if (settlements > 0 && !force) {
    console.error(`  ${settlements} settlement(s) reference this event's tickets.`);
    console.error('  Those are ledger rows. Pass --force if you are certain they are test data.\n');
    process.exit(1);
  }

  const removed: Array<[string, number]> = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [table, sql] of STEPS) {
      try {
        const n = Number(db.prepare(sql).run(eventId).changes);
        if (n > 0) removed.push([table, n]);
      } catch (e) {
        // A table that does not exist in this schema version is not a failure;
        // one that exists and refuses the delete is.
        if (!/no such table/i.test((e as Error).message)) throw e;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(`\n  Rolled back: ${(e as Error).message}\n`);
    process.exit(1);
  }

  for (const [table, n] of removed) console.log(`  ${String(n).padStart(4)}  ${table}`);
  console.log(`\n  Removed. The catalogue no longer lists it.\n`);
} finally {
  db.close();
}
