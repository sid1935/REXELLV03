import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { migrate } from './migrate.js';
import type { MigrationResult } from './migrate.js';

export type Row = Record<string, unknown>;

/**
 * A thin wrapper over `node:sqlite`.
 *
 * Deliberately thin. The interesting concurrency work in this system is a small
 * number of conditional UPDATE statements whose `changes` count is the guard —
 * see `reserve()` in repo.ts — and an ORM that hides how a statement is built
 * makes those harder to reason about, not easier.
 */
export class Db {
  readonly handle: DatabaseSync;
  #statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  #txDepth = 0;
  /** What opening this database changed, if anything. Logged by the server. */
  readonly migration: MigrationResult;

  constructor(location = ':memory:') {
    this.handle = new DatabaseSync(location);
    try {
      // WAL lets readers run while a writer holds the write lock. Irrelevant in
      // memory, essential on disk under an onsale.
      if (location !== ':memory:') this.handle.exec('PRAGMA journal_mode = WAL');
      this.handle.exec('PRAGMA foreign_keys = ON');
      this.handle.exec('PRAGMA busy_timeout = 5000');
      // Opening a database and migrating it are the same act. There is no separate
      // command to forget, and no window where the process serves requests against
      // a schema it does not match.
      this.migration = migrate(this.handle);
    } catch (cause) {
      // A constructor that throws leaves no object for anyone to close, so the
      // handle would leak — a file descriptor per failed start, and on Windows a
      // lock nobody can release without ending the process.
      try {
        this.handle.close();
      } catch {
        // Already closed, or never opened. The original failure is the one that matters.
      }
      throw cause;
    }
  }

  prepare(sql: string) {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.handle.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  /** Returns the number of rows actually changed — the guard for conditional writes. */
  run(sql: string, ...params: unknown[]): number {
    const result = this.prepare(sql).run(...(params as never[]));
    return Number(result.changes);
  }

  /**
   * BEGIN IMMEDIATE, not BEGIN.
   *
   * A deferred transaction takes the write lock lazily, which means two
   * concurrent buyers can both read "one ticket left" before either writes, and
   * one of them gets SQLITE_BUSY on upgrade after already doing work. IMMEDIATE
   * takes the lock up front so contention is resolved before any decision is
   * made on stale data. Postgres gets the same behaviour from the conditional
   * UPDATE alone, but the explicit lock costs nothing and documents the intent.
   */
  tx<T>(fn: () => T): T {
    if (this.#txDepth > 0) {
      // Nested calls join the outer transaction rather than opening a savepoint.
      // Every nested use in this codebase wants all-or-nothing with its parent.
      this.#txDepth += 1;
      try {
        return fn();
      } finally {
        this.#txDepth -= 1;
      }
    }

    this.handle.exec('BEGIN IMMEDIATE');
    this.#txDepth = 1;
    try {
      const result = fn();
      this.handle.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.handle.exec('ROLLBACK');
      } catch {
        // A rollback failure means the transaction was already resolved. The
        // original error is the one worth surfacing.
      }
      throw error;
    } finally {
      this.#txDepth = 0;
    }
  }

  close(): void {
    this.#statements.clear();
    this.handle.close();
  }
}

const PREFIXES = {
  person: 'per',
  identity: 'idn',
  consent: 'con',
  organizer: 'org',
  event: 'evt',
  tier: 'tir',
  hold: 'hld',
  order: 'ord',
  ticket: 'tkt',
  listing: 'lst',
  settlement: 'stl',
  attestation: 'att',
  signal: 'sig',
} as const;

/** Prefixed ids, because a bare UUID in a log line tells you nothing. */
export function newId(kind: keyof typeof PREFIXES): string {
  return `${PREFIXES[kind]}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
