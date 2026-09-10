import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_VERSION, Db, MIGRATIONS, MigrationError, migrate, schemaStatus } from '../src/index.js';

let dir: string;
const dbPath = () => join(dir, 'test.sqlite');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rexell-migrate-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A database as it looked before M6, when `organizers` had three columns. */
function legacyDatabase(): void {
  const legacy = new DatabaseSync(dbPath());
  legacy.exec(`
    CREATE TABLE organizers (
      organizer_id TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
    CREATE TABLE events (
      event_id                 TEXT PRIMARY KEY,
      organizer_id             TEXT NOT NULL,
      name                     TEXT NOT NULL,
      capacity                 INTEGER NOT NULL,
      sales_open_at            INTEGER NOT NULL,
      sales_close_at           INTEGER NOT NULL,
      doors_open_at            INTEGER NOT NULL,
      ends_at                  INTEGER NOT NULL,
      max_tickets_per_identity INTEGER NOT NULL,
      minimum_age              INTEGER,
      allow_reentry            INTEGER NOT NULL DEFAULT 0,
      policy_hash              TEXT NOT NULL,
      created_at               INTEGER NOT NULL
    );
  `);
  legacy.prepare('INSERT INTO organizers VALUES (?,?,?)').run('org_existing', 'Pinewood Live', 1_780_000_000_000);
  legacy.close();
}

describe('a fresh database', () => {
  it('opens at the current version with nothing to do afterwards', () => {
    const db = new Db(dbPath());
    expect(db.migration.from).toBe(0);
    expect(db.migration.to).toBe(CURRENT_VERSION);
    expect(schemaStatus(db.handle).upToDate).toBe(true);
    db.close();
  });

  it('changes nothing on a second open', () => {
    const first = new Db(dbPath());
    first.close();

    const second = new Db(dbPath());
    expect(second.migration.applied).toEqual([]);
    expect(second.migration.from).toBe(CURRENT_VERSION);
    second.close();
  });
});

describe('the bug this module exists for', () => {
  it('upgrades a pre-M6 database instead of failing on the first signup', () => {
    legacyDatabase();

    // Before: exactly the failure that shipped. `CREATE TABLE IF NOT EXISTS`
    // sees `organizers` and does nothing, so the column never appears.
    const before = new DatabaseSync(dbPath());
    expect(
      (before.prepare('PRAGMA table_info(organizers)').all() as Array<{ name: string }>).map((c) => c.name),
    ).not.toContain('contact_email');
    before.close();

    const db = new Db(dbPath());
    expect(db.migration.from).toBe(0);
    expect(db.migration.applied.map((m) => m.name)).toContain('organizer contact details and account state');

    // After: the column is there and a signup writes.
    expect(() =>
      db.run(
        'INSERT INTO organizers (organizer_id, name, contact_email, state, created_at) VALUES (?,?,?,?,?)',
        'org_new',
        'New Promoter',
        'ops@example.com',
        'active',
        1_780_000_000_000,
      ),
    ).not.toThrow();

    // And the row that was already there survived, with a sensible default.
    const existing = db.get<{ name: string; state: string; contact_email: string | null }>(
      'SELECT name, state, contact_email FROM organizers WHERE organizer_id = ?',
      'org_existing',
    );
    expect(existing).toMatchObject({ name: 'Pinewood Live', state: 'active', contact_email: null });
    db.close();
  });

  it('adds the chain columns an older tickets table is missing', () => {
    legacyDatabase();
    const db = new Db(dbPath());

    const eventCols = (db.handle.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(eventCols).toContain('chain_address');
    expect(eventCols).toContain('manifest_sequence');
    db.close();
  });

  it('creates tables that did not exist at all in the older schema', () => {
    legacyDatabase();
    const db = new Db(dbPath());
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((t) => t.name);

    // Everything M1 onwards added.
    for (const table of ['api_keys', 'chain_outbox', 'scanners', 'consents', 'settlements', 'manifest_deltas']) {
      expect(tables, `missing ${table}`).toContain(table);
    }
    db.close();
  });
});

describe('safety', () => {
  it('refuses to run old code against a newer database', () => {
    // A rollback. This build does not know what changed, so it may write rows
    // the newer schema rejects or read a column whose meaning has moved.
    const db = new Db(dbPath());
    db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)', 999, 'from the future', 1);
    db.close();

    expect(() => new Db(dbPath())).toThrow(MigrationError);
    expect(() => new Db(dbPath())).toThrow(/Deploy a newer build/);
  });

  it('leaves the version alone when a migration fails', () => {
    const db = new Db(dbPath());
    const before = schemaStatus(db.handle).version;

    const doomed = [
      ...MIGRATIONS,
      {
        version: CURRENT_VERSION + 1,
        name: 'doomed',
        up() {
          throw new Error('deliberate');
        },
      },
    ];

    // Applying the list by hand, since `migrate` reads the module-level one.
    expect(() => {
      for (const m of doomed) {
        if (m.version <= before) continue;
        db.handle.exec('BEGIN IMMEDIATE');
        try {
          m.up(db.handle);
          db.handle
            .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)')
            .run(m.version, m.name, Date.now());
          db.handle.exec('COMMIT');
        } catch (e) {
          db.handle.exec('ROLLBACK');
          throw e;
        }
      }
    }).toThrow(/deliberate/);

    // The failed version was not recorded, so a retry runs it again rather than
    // skipping it as done.
    expect(schemaStatus(db.handle).version).toBe(before);
    db.close();
  });

  it('has no duplicate or out-of-order versions', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(Math.min(...versions)).toBe(1);
  });

  it('every migration is idempotent — running it twice is a no-op', () => {
    const db = new Db(dbPath());
    // They have all run once already. Running them again must not throw, which
    // is what makes them safe on a database that already has the change.
    for (const m of MIGRATIONS) {
      expect(() => m.up(db.handle), `${m.name} is not idempotent`).not.toThrow();
    }
    db.close();
  });
});

describe('the whole path, twice', () => {
  it('legacy → current → current is stable', () => {
    legacyDatabase();

    const first = new Db(dbPath());
    const afterFirst = schemaStatus(first.handle);
    first.close();

    const second = new Db(dbPath());
    expect(second.migration.applied).toEqual([]);
    expect(schemaStatus(second.handle)).toEqual(afterFirst);
    second.close();
  });

  it('reports what it did, so a deploy is not a guess', () => {
    legacyDatabase();
    const db = new Db(dbPath());
    expect(db.migration.applied.length).toBeGreaterThan(0);
    expect(db.migration).toMatchObject({ from: 0, to: CURRENT_VERSION });
    db.close();
  });
});

describe('migrate() directly', () => {
  it('is safe to call on an already-open handle', () => {
    const handle = new DatabaseSync(dbPath());
    const first = migrate(handle);
    const second = migrate(handle);
    expect(first.to).toBe(CURRENT_VERSION);
    expect(second.applied).toEqual([]);
    handle.close();
  });
});
