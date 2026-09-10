import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';

/**
 * Schema migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` is enough to stand a database up and is not
 * enough to change one. It silently does nothing when the table already exists,
 * so a column added in a later milestone never appears on an older database and
 * the failure arrives much later, as a raw SQLite error from inside a route.
 *
 * That happened here: M6 added `contact_email` and `state` to `organizers`, and
 * any database created before M6 would take a signup request and fail with
 * "table organizers has no column named contact_email". This module exists so
 * that class of bug is closed rather than repeated.
 *
 * The scheme, deliberately small:
 *
 *   1. `SCHEMA_SQL` runs first and creates anything missing. It is the shape a
 *      fresh database should have, and it is safe to re-run.
 *   2. Numbered migrations then fix up anything `IF NOT EXISTS` cannot: added
 *      columns, backfills, index changes.
 *   3. Each migration is introspective and idempotent, so it is safe on a fresh
 *      database that already has the change and on an old one that does not.
 *
 * The third rule is what makes this work without a separate baseline dump. It
 * costs one `PRAGMA table_info` per migration and removes the whole category of
 * "which schema version was this file created at".
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: DatabaseSync): void;
}

function columns(db: DatabaseSync, table: string): string[] {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  } catch {
    return [];
  }
}

function addColumn(db: DatabaseSync, table: string, column: string, definition: string): boolean {
  if (columns(db, table).includes(column)) return false;
  // SQLite cannot add a NOT NULL column without a default, and neither can
  // Postgres without rewriting the table. Every column added here carries one.
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/**
 * The list. Append only, never renumber, never edit a shipped entry.
 *
 * Editing one that has already run somewhere means two databases silently
 * disagree about what version 3 was, which is the failure this whole file is
 * meant to prevent.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline',
    up() {
      // SCHEMA_SQL has already run. Recorded so a fresh database starts at a
      // known version rather than at zero.
    },
  },
  {
    version: 2,
    name: 'organizer contact details and account state',
    up(db) {
      // M6. Present on any database created after it, absent on any created
      // before, and `CREATE TABLE IF NOT EXISTS` cannot tell the difference.
      addColumn(db, 'organizers', 'contact_email', 'TEXT');
      addColumn(db, 'organizers', 'state', `TEXT NOT NULL DEFAULT 'active'`);
    },
  },
  {
    version: 3,
    name: 'chain address and mint state on existing rows',
    up(db) {
      // M3. Same situation: added to the schema, invisible to an older file.
      addColumn(db, 'events', 'chain_address', 'TEXT');
      addColumn(db, 'tickets', 'token_id', 'TEXT');
      addColumn(db, 'tickets', 'mint_state', `TEXT NOT NULL DEFAULT 'pending'`);
      addColumn(db, 'events', 'manifest_sequence', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
];

export const CURRENT_VERSION = MIGRATIONS.reduce((n, m) => Math.max(n, m.version), 0);

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: ReadonlyArray<{ version: number; name: string }>;
}

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/**
 * Bring a database up to date.
 *
 * Called from the `Db` constructor, so opening a database is the same thing as
 * migrating it. There is no separate command anybody can forget to run, and no
 * window in which the process is serving requests against a schema it does not
 * match.
 */
export function migrate(db: DatabaseSync): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    );
  `);

  // Everything a fresh database needs. Idempotent, so it is also a no-op on an
  // existing one — except for tables added since, which it creates.
  db.exec(SCHEMA_SQL);

  const from = currentVersion(db);

  if (from > CURRENT_VERSION) {
    // Old code, newer database. Refusing is the only safe move: this build does
    // not know what changed and may write rows the newer schema rejects, or
    // read columns whose meaning has moved.
    throw new MigrationError(
      `this database is at schema version ${from} but this build only knows up to ${CURRENT_VERSION}. ` +
        `Deploy a newer build rather than letting this one write to it.`,
    );
  }

  const applied: Array<{ version: number; name: string }> = [];
  const now = Date.now();

  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (migration.version <= from) continue;

    // One transaction per migration, so a failure half way through leaves the
    // database at the last version that fully applied rather than somewhere
    // between two.
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)').run(
        migration.version,
        migration.name,
        now,
      );
      db.exec('COMMIT');
      applied.push({ version: migration.version, name: migration.name });
    } catch (cause) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Already resolved. The original error is the one worth reporting.
      }
      throw new MigrationError(
        `migration ${migration.version} (${migration.name}) failed: ${(cause as Error).message}`,
      );
    }
  }

  return { from, to: currentVersion(db), applied };
}

/** For a health endpoint, so a deploy can be checked without guessing. */
export function schemaStatus(db: DatabaseSync): { version: number; expected: number; upToDate: boolean } {
  const version = currentVersion(db);
  return { version, expected: CURRENT_VERSION, upToDate: version === CURRENT_VERSION };
}
