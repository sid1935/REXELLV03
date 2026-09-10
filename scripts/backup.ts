/**
 * Back up both databases.
 *
 *   npm run backup -- /var/backups/rexell
 *
 * `VACUUM INTO` rather than copying the file: SQLite in WAL mode is two files
 * plus a shared-memory region, and copying the main database while a write is
 * in flight produces something that looks fine and restores corrupt. VACUUM
 * INTO takes a read lock and writes a single consistent, already-compacted
 * database — the API keeps serving while it runs.
 *
 * What this does NOT back up is VAULT_MASTER_KEY. A vault backup without that
 * key is a file of unreadable ciphertext. Keep the key somewhere else, and
 * confirm you can actually read it before you need it.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('usage: npm run backup -- <directory>');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = resolve(target, stamp);
mkdirSync(dir, { recursive: true });

const sources = [
  { name: 'rexell', path: process.env['REXELL_DB'] ?? 'rexell.sqlite' },
  { name: 'vault', path: process.env['VAULT_DB'] ?? 'vault.sqlite' },
];

let failures = 0;
for (const source of sources) {
  const out = join(dir, `${source.name}.sqlite`);
  try {
    const db = new DatabaseSync(source.path, { readOnly: true });
    try {
      // The path is interpolated because SQLite does not accept a bound
      // parameter here. It comes from argv on an operator's own machine, and
      // the quotes are doubled so a path with an apostrophe cannot break out.
      db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    console.log(`  ${source.name.padEnd(7)} ${(statSync(out).size / 1024).toFixed(0)} KiB  ${out}`);
  } catch (e) {
    failures += 1;
    console.error(`  ${source.name.padEnd(7)} FAILED  ${(e as Error).message}`);
  }
}

if (failures > 0) {
  // Non-zero, so a cron that ignores stdout still reports the failure.
  console.error(`\n${failures} of ${sources.length} backups failed.`);
  process.exit(1);
}
console.log(`\nBoth databases written to ${dir}`);
console.log('Remember: the vault backup is unreadable without VAULT_MASTER_KEY.');
