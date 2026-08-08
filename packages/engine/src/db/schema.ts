/**
 * Schema for the run store.
 *
 * Run state is persisted after every step so a crashed or closed run can be
 * resumed, replayed or exported. That means the unit of
 * persistence is the turn, not the run: every model call is written the moment
 * it finishes, with its exact prompt and its byte-exact reply.
 *
 * Written for `node:sqlite`, which ships with Node 22.5+ — no native module to
 * compile, which matters for a desktop app that has to install cleanly on a
 * machine with no build toolchain.
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  id                 TEXT PRIMARY KEY,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  title              TEXT NOT NULL,
  prompt             TEXT NOT NULL,
  status             TEXT NOT NULL,
  outcome            TEXT,
  settings_json      TEXT NOT NULL,
  classification_json TEXT,
  seat_ids_json      TEXT NOT NULL,
  primary_seat_id    TEXT,
  final_answer       TEXT,
  final_answer_key   TEXT,
  template_snapshot_json TEXT NOT NULL DEFAULT '{}',
  stats_json         TEXT NOT NULL DEFAULT '{}',
  verification_json  TEXT,
  error              TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);

CREATE TABLE IF NOT EXISTS rounds (
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  round         INTEGER NOT NULL,
  letters_json  TEXT NOT NULL,
  critics_json  TEXT NOT NULL DEFAULT '{}',
  state_hash    TEXT NOT NULL DEFAULT '',
  consensus_json TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  PRIMARY KEY (run_id, round)
);

CREATE TABLE IF NOT EXISTS turns (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  round        INTEGER NOT NULL,
  seat_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  letter       TEXT,
  prompt_hash  TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  raw          TEXT NOT NULL,
  verdict_json TEXT,
  parse_source TEXT,
  answer       TEXT,
  answer_key   TEXT,
  answer_hash  TEXT,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  cost_usd     REAL,
  failure_json TEXT,
  lossy        INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_run ON turns(run_id, round, seat_id);

CREATE TABLE IF NOT EXISTS run_seats (
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seat_id         TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  adapter         TEXT NOT NULL,
  family          TEXT NOT NULL,
  status          TEXT NOT NULL,
  answer          TEXT,
  answer_key      TEXT,
  flips           INTEGER NOT NULL DEFAULT 0,
  agreed_rounds_json TEXT NOT NULL DEFAULT '[]',
  dropped_at_round INTEGER,
  drop_reason     TEXT,
  messages_used   INTEGER NOT NULL DEFAULT 0,
  lossy           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, seat_id)
);

-- Lifetime per-model accuracy, built from the user's own questions (3.2 item 5).
CREATE TABLE IF NOT EXISTS scoreboard (
  seat_id              TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,
  runs                 INTEGER NOT NULL DEFAULT 0,
  correct_first        INTEGER NOT NULL DEFAULT 0,
  overruled            INTEGER NOT NULL DEFAULT 0,
  persuaded            INTEGER NOT NULL DEFAULT 0,
  flips                INTEGER NOT NULL DEFAULT 0,
  talked_out_of_correct INTEGER NOT NULL DEFAULT 0,
  withdrawals          INTEGER NOT NULL DEFAULT 0,
  non_compliant        INTEGER NOT NULL DEFAULT 0,
  latency_total_ms     INTEGER NOT NULL DEFAULT 0,
  latency_samples      INTEGER NOT NULL DEFAULT 0,
  last_seen            INTEGER NOT NULL DEFAULT 0
);

-- Rolling per-seat message history, so a daily quota cap survives a restart.
CREATE TABLE IF NOT EXISTS budget_history (
  seat_id TEXT NOT NULL,
  at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_budget_seat_at ON budget_history(seat_id, at);

-- The automation activity log, hash-chained (see runtime/audit.ts).
CREATE TABLE IF NOT EXISTS audit_log (
  seq       INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL,
  actor     TEXT NOT NULL,
  seat_id   TEXT,
  run_id    TEXT,
  action    TEXT NOT NULL,
  target    TEXT,
  detail    TEXT,
  ok        INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);
`;
