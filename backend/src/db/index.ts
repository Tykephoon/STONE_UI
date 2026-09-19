/**
 * SQLite connection management.
 *
 * WAL mode lets the dashboard's read queries run concurrently with device
 * ingest writes, which is the entire concurrency story this service needs.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { config } from '../config.js';
import { runMigrations } from './migrations.js';

let instance: Database | null = null;

export function openDatabase(path: string = config.DATABASE_PATH): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new BetterSqlite3(path);

  // Foreign keys are off by default in SQLite; the ON DELETE CASCADE rules in
  // the schema are load-bearing for account deletion, so this is required.
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  return db;
}

/** Process-wide connection. Tests build their own with `openDatabase(':memory:')`. */
export function getDatabase(): Database {
  if (!instance) {
    instance = openDatabase();
  }
  return instance;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export type { Database };
