import type { DatabaseSync } from 'node:sqlite';

import { logger } from '../util/logger.js';

const log = logger('migrate');

/**
 * Schema migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists,
 * so adding a column to the schema silently does nothing on an existing
 * database — and then every write fails with "table has no column named X".
 * That breaks upgrades for exactly the users who have run the app before,
 * which is the worst possible group to break.
 *
 * So additive columns are declared here as well as in the schema, and applied
 * with `ALTER TABLE ADD COLUMN` when missing. Declaring them twice is
 * deliberate: a fresh database gets a clean schema, an existing one gets the
 * delta, and both end up identical.
 *
 * Rules for anything added to this list:
 *   - additive only (new nullable column, new table, new index);
 *   - never destructive — no DROP, no type change, no NOT NULL without a
 *     default, because a failed migration must never cost the user their runs;
 *   - safe to apply twice.
 */
interface ColumnMigration {
  table: string;
  column: string;
  /** Full column definition, minus the name. */
  definition: string;
  note: string;
}

const COLUMNS: ColumnMigration[] = [
  {
    table: 'runs',
    column: 'verification_json',
    definition: 'TEXT',
    note: 'self-consistency, cross-check and calibrated confidence',
  },
];

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    return new Set(rows.map((r) => String(r.name)));
  } catch {
    return new Set();
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name?: unknown } | undefined;
  return Boolean(row?.name);
}

/**
 * Bring an existing database up to the current schema.
 * Runs after the schema itself, so fresh databases pass through untouched.
 */
export function migrate(db: DatabaseSync): void {
  const applied: string[] = [];

  for (const m of COLUMNS) {
    if (!tableExists(db, m.table)) continue; // fresh DB: the schema already made it
    if (columnsOf(db, m.table).has(m.column)) continue;

    try {
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.definition}`);
      applied.push(`${m.table}.${m.column}`);
      log.info(`migrated: added ${m.table}.${m.column} (${m.note})`);
    } catch (err) {
      // A migration that cannot be applied is worth shouting about, but it must
      // not stop the engine from starting -- the user's run history is in here.
      log.error(
        `could not add ${m.table}.${m.column}: ${String(err)}. ` +
          `Writes touching that column will fail until this is resolved.`,
      );
    }
  }

  if (applied.length === 0) return;
  log.info(`schema migration complete (${applied.length} change(s))`);
}

/** Every additive column this build expects, for the self-check below. */
export function expectedColumns(): ColumnMigration[] {
  return COLUMNS;
}

/**
 * Verify the live database actually matches what the code writes.
 * Cheap, runs once at startup, and turns a mid-run write failure into a clear
 * message at boot.
 */
export function verifySchema(db: DatabaseSync): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const m of COLUMNS) {
    if (!tableExists(db, m.table)) continue;
    if (!columnsOf(db, m.table).has(m.column)) missing.push(`${m.table}.${m.column}`);
  }
  return { ok: missing.length === 0, missing };
}
