/**
 * Forward-only schema migrations.
 *
 * Each entry runs exactly once, inside a transaction, in array order. Applied
 * versions are recorded in `schema_migrations`. Never edit a migration that has
 * shipped — append a new one.
 */
import type { Database } from 'better-sqlite3';

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: /* sql */ `
      -- ---------------------------------------------------------------
      -- users
      -- ---------------------------------------------------------------
      CREATE TABLE users (
        id             TEXT PRIMARY KEY,
        email          TEXT NOT NULL UNIQUE,  -- normalised: trimmed + lowercased
        email_display  TEXT NOT NULL,         -- as the user typed it
        password_hash  TEXT NOT NULL,         -- Argon2id
        display_name   TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      -- ---------------------------------------------------------------
      -- sessions
      --
      -- The cookie carries an opaque 256-bit token; only its SHA-256 lives
      -- here, so a database leak does not yield usable sessions. csrf_token is
      -- stored in the clear on purpose: it is a synchroniser token, worthless
      -- without the httpOnly session cookie it is bound to.
      -- ---------------------------------------------------------------
      CREATE TABLE sessions (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash          TEXT NOT NULL UNIQUE,
        csrf_token          TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        expires_at          TEXT NOT NULL,  -- sliding window
        absolute_expires_at TEXT NOT NULL,  -- hard cap, never extended
        last_used_at        TEXT NOT NULL,
        user_agent          TEXT
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);
      CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

      -- ---------------------------------------------------------------
      -- devices
      --
      -- key_hash is SHA-256 of a 256-bit random secret. Argon2 is the right
      -- answer for human-chosen passwords; for a full-entropy machine key it
      -- would only add latency to every ingest call without adding security,
      -- because there is no dictionary to search.
      -- ---------------------------------------------------------------
      CREATE TABLE devices (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        key_hash       TEXT NOT NULL UNIQUE,
        key_prefix     TEXT NOT NULL,   -- non-secret, shown in the UI for identification
        notes          TEXT,
        created_at     TEXT NOT NULL,
        key_rotated_at TEXT,
        last_seen_at   TEXT
      );
      CREATE INDEX idx_devices_user ON devices(user_id);

      -- ---------------------------------------------------------------
      -- readings (append-only)
      --
      -- user_id is denormalised from devices so that every read path can scope
      -- by owner in the WHERE clause without a join, and so ownership can never
      -- be accidentally omitted.
      -- ---------------------------------------------------------------
      CREATE TABLE readings (
        id                      TEXT PRIMARY KEY,
        device_id               TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

        recorded_at             TEXT NOT NULL,     -- device clock, UTC ISO-8601
        received_at             TEXT NOT NULL,     -- server clock, UTC ISO-8601
        clock_skew_ms           INTEGER NOT NULL,  -- received_at - recorded_at

        latitude                REAL NOT NULL,
        longitude               REAL NOT NULL,
        altitude_m              REAL,
        gps_accuracy_m          REAL,

        tire_fl_pressure_kpa    REAL,
        tire_fl_temp_c          REAL,
        tire_fr_pressure_kpa    REAL,
        tire_fr_temp_c          REAL,
        tire_rl_pressure_kpa    REAL,
        tire_rl_temp_c          REAL,
        tire_rr_pressure_kpa    REAL,
        tire_rr_temp_c          REAL,

        ambient_temp_c          REAL,
        humidity_pct            REAL,
        barometric_pressure_hpa REAL,
        accel_x_g               REAL,
        accel_y_g               REAL,
        accel_z_g               REAL,
        battery_voltage_v       REAL,

        extra                   TEXT NOT NULL DEFAULT '{}',  -- JSON: unknown device keys, preserved
        created_at              TEXT NOT NULL
      );
      CREATE INDEX idx_readings_user_time   ON readings(user_id, recorded_at DESC);
      CREATE INDEX idx_readings_device_time ON readings(device_id, recorded_at DESC);

      -- Immutability is enforced by the database, not by the honour system of
      -- never having written an UPDATE statement.
      CREATE TRIGGER readings_are_immutable
      BEFORE UPDATE ON readings
      BEGIN
        SELECT RAISE(ABORT, 'readings are immutable');
      END;

      -- ---------------------------------------------------------------
      -- designs (3D studio)
      -- ---------------------------------------------------------------
      CREATE TABLE designs (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        params      TEXT NOT NULL,   -- JSON generator + material parameters
        latitude    REAL,
        longitude   REAL,
        place_label TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX idx_designs_user ON designs(user_id, updated_at DESC);

      -- A share grants read access to exactly one design and carries no user
      -- identity, so a leaked link cannot be widened into account access.
      CREATE TABLE design_shares (
        token_hash TEXT PRIMARY KEY,
        design_id  TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX idx_design_shares_design ON design_shares(design_id);

      -- ---------------------------------------------------------------
      -- auth throttling (per-account, survives restarts and IP rotation)
      -- ---------------------------------------------------------------
      CREATE TABLE auth_throttle (
        key          TEXT PRIMARY KEY,   -- e.g. "login:user@example.com"
        failures     INTEGER NOT NULL DEFAULT 0,
        window_start TEXT NOT NULL,
        locked_until TEXT
      );
    `,
  },
];

export function runMigrations(db: Database): { applied: number[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const alreadyApplied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version),
  );

  const applied: number[] = [];

  for (const migration of migrations) {
    if (alreadyApplied.has(migration.version)) continue;

    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString());
    });

    run();
    applied.push(migration.version);
  }

  return { applied };
}
