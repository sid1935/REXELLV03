/**
 * Back up both databases.
 *
 *   npm run backup -- /var/backups/rexell
 *   docker compose exec api node scripts/backup.js /data/backups
 *
 * Plain JavaScript, not TypeScript, and deliberately so: the runtime image
 * prunes dev dependencies, `tsx` is one of them, and a backup command that
 * only works on a developer's laptop is not a backup command.
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
import { existsSync, mkdirSync, statSync } from 'node:fs';
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
let written = 0;
for (const source of sources) {
  const out = join(dir, `${source.name}.sqlite`);

  /*
   * A database this process cannot see is skipped, not failed.
   *
   * The API and the vault hold separate volumes and never share one, so
   * running this in either container legitimately finds only one of the two.
   * Treating the absent one as an error would make every containerised backup
   * exit non-zero and train whoever reads the cron mail to ignore it.
   */
  if (!existsSync(source.path)) {
    console.log(`  ${source.name.padEnd(7)} skipped — no database at ${source.path}`);
    continue;
  }

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
    written += 1;
    console.log(`  ${source.name.padEnd(7)} ${(statSync(out).size / 1024).toFixed(0)} KiB  ${out}`);
  } catch (e) {
    failures += 1;
    console.error(`  ${source.name.padEnd(7)} FAILED  ${e.message}`);
  }
}

if (failures > 0) {
  // Non-zero, so a cron that ignores stdout still reports the failure.
  console.error(`\n${failures} of ${sources.length} backups failed.`);
  process.exit(1);
}
if (written === 0) {
  // Every source skipped means the paths are wrong, and a run that quietly
  // produces an empty directory is the failure mode this whole script exists
  // to avoid.
  console.error('\nNothing was backed up. Set REXELL_DB and VAULT_DB to real paths.');
  process.exit(1);
}

console.log(`\n${written} database(s) written to ${dir}`);
console.log('Remember: the vault backup is unreadable without VAULT_MASTER_KEY.');
