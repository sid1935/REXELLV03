/**
 * Issue an API key to an organizer that has lost theirs.
 *
 *   REXELL_DB=/var/lib/rexell/rexell.sqlite npm run issue:key -- "Gate Demo"
 *   REXELL_DB=… npm run issue:key -- org_fb4b6cc951000c07856f
 *
 * Keys are stored as SHA-256 hashes and shown exactly once, which is the right
 * design and leaves one hole: an organizer whose only key is lost cannot mint a
 * replacement, because minting one requires a key. `POST /v1/keys` deliberately
 * refuses to be the way out of that — a route that issues credentials without
 * holding one is a route somebody will eventually point at the internet.
 *
 * So it is an operator's tool instead: on the host, against the database, by
 * somebody who already has root. That is the correct amount of difficulty.
 *
 * ⚠ It prints a live credential to a terminal. It is not in the deploy path and
 * nothing calls it automatically. Revoke the key from the console's Account tab
 * when whatever it was needed for is done.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ALL_SCOPES } from '@rexell/db';

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim();
const path = process.env['REXELL_DB'] ?? 'rexell.sqlite';
const label = process.env['KEY_NAME'] ?? 'Recovered key';

if (!wanted) {
  console.error('\n  usage: npm run issue:key -- <organizer id or name>\n');
  process.exit(2);
}

/*
 * Every one of these must match `apps/api/src/auth.ts`. A key minted with a
 * different prefix or a different hash is a key the API will never recognise,
 * and the failure looks exactly like a typo in the key.
 */
const PREFIX = 'rxl_live_';
// Imported rather than retyped. A hand-written list drifts from the real one
// silently — the key works, and then one route refuses it for a scope that was
// never granted because it was never spelled correctly.
const SCOPES = ALL_SCOPES;

const db = new DatabaseSync(path);
try {
  const rows = db
    .prepare('SELECT organizer_id, name, state FROM organizers WHERE organizer_id = ? OR name LIKE ?')
    .all(wanted, `%${wanted}%`) as Array<{ organizer_id: string; name: string; state: string }>;

  if (rows.length === 0) {
    console.error(`\n  No organizer matching ${JSON.stringify(wanted)} in ${path}.\n`);
    process.exit(1);
  }
  if (rows.length > 1) {
    // Never guess which one. Issuing a credential to the wrong organizer is not
    // a mistake that announces itself.
    console.error(`\n  ${rows.length} organizers match ${JSON.stringify(wanted)}:\n`);
    for (const r of rows) console.error(`    ${r.organizer_id}  ${r.name}`);
    console.error('\n  Re-run with the id.\n');
    process.exit(1);
  }

  const org = rows[0]!;
  if (org.state !== 'active') {
    console.error(`\n  ${org.name} is ${org.state}. Reactivate before issuing a key.\n`);
    process.exit(1);
  }

  const secret = randomBytes(32).toString('base64url');
  const key = `${PREFIX}${secret}`;
  db.prepare(
    'INSERT INTO api_keys (key_id, organizer_id, name, key_hash, prefix, scopes, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(
    `key_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    org.organizer_id,
    label,
    createHash('sha256').update(key).digest('hex'),
    `${PREFIX}${secret.slice(0, 6)}…`,
    SCOPES.join(','),
    Date.now(),
  );

  console.log(`\n  ${org.name}`);
  console.log(`  ${org.organizer_id}`);
  console.log(`  scopes: ${SCOPES.join(', ')}\n`);
  console.log('  Paste this into the console under Account → I already have a key:\n');
  console.log(`  ${key}\n`);
  console.log('  Shown once. Revoke it from the Account tab when you are done with it.\n');
} finally {
  db.close();
}
