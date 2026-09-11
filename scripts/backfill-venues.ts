/**
 * Fill in the venue for events created before the column existed.
 *
 *   REXELL_DB=/var/lib/rexell/rexell.sqlite npm run backfill:venues
 *
 * Migration 5 added `events.venue` as nullable, because an event created
 * before it genuinely has no answer and inventing one would be worse than
 * leaving it blank. The catalogue this repository publishes does have an
 * answer for its own events, and until they carry it a search for a city
 * finds nothing — which looks exactly like a broken search.
 *
 * Writes to the database rather than through the API because there is no
 * route that edits an event, deliberately: an organizer must not be able to
 * change the terms after inventory has sold. A venue is not a term — it is a
 * display field — so backfilling it here is safe, and adding an edit route for
 * it would open a door that the policy hash exists to keep shut.
 *
 * Idempotent, and it only touches rows whose venue is still missing.
 */
import { DatabaseSync } from 'node:sqlite';
import { CATALOGUE } from './catalogue.js';

const path = process.env['REXELL_DB'] ?? 'rexell.sqlite';

const db = new DatabaseSync(path);
try {
  const has = (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).some((c) => c.name === 'venue');
  if (!has) {
    console.error(`\n  ${path} has no venue column yet. Start the API once so migrations run, then re-run this.\n`);
    process.exit(1);
  }

  const update = db.prepare('UPDATE events SET venue = ? WHERE event_id = ? AND (venue IS NULL OR venue = ?)');
  let filled = 0;
  let already = 0;
  let absent = 0;

  console.log(`\n  ${path}\n`);
  for (const spec of CATALOGUE) {
    const row = db.prepare('SELECT venue FROM events WHERE event_id = ?').get(spec.id) as
      | { venue: string | null }
      | undefined;
    if (!row) {
      absent += 1;
      continue;
    }
    if (row.venue === spec.venue) {
      already += 1;
      continue;
    }
    const changed = Number(update.run(spec.venue, spec.id, '').changes);
    if (changed) {
      filled += 1;
      console.log(`  ${spec.id.padEnd(28)} ${spec.venue}`);
    }
  }

  console.log(`\n  ${filled} filled, ${already} already correct, ${absent} not in this database.\n`);
} finally {
  db.close();
}
