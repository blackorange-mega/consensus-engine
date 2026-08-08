import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_SETTINGS, type RunRecord } from '@consensus/shared';

import { migrate, verifySchema, expectedColumns } from '../src/db/migrate.js';
import { SCHEMA } from '../src/db/schema.js';
import { Store } from '../src/db/store.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

/** The runs table exactly as an earlier release created it. */
const LEGACY_RUNS = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER, title TEXT, prompt TEXT,
  status TEXT, outcome TEXT, settings_json TEXT, classification_json TEXT, seat_ids_json TEXT,
  primary_seat_id TEXT, final_answer TEXT, final_answer_key TEXT, template_snapshot_json TEXT,
  stats_json TEXT, error TEXT
);`;

describe('schema migration', () => {
  it('adds columns that a pre-existing database is missing', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(LEGACY_RUNS);
    db.prepare('INSERT INTO runs (id, title) VALUES (?, ?)').run('old-run', 'from a previous version');

    // CREATE TABLE IF NOT EXISTS is a no-op here, which is the whole problem.
    db.exec(SCHEMA);
    expect(verifySchema(db).ok).toBe(false);

    migrate(db);
    expect(verifySchema(db).ok).toBe(true);

    // The write that used to fail now works...
    db.prepare('UPDATE runs SET verification_json = ? WHERE id = ?').run('{"confidence":0.8}', 'old-run');

    // ...and the user's existing run survived the upgrade untouched.
    const row = db.prepare('SELECT title, verification_json FROM runs WHERE id = ?').get('old-run') as {
      title: string;
      verification_json: string;
    };
    expect(row.title).toBe('from a previous version');
    expect(row.verification_json).toContain('0.8');
  });

  it('is a no-op on a fresh database', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    expect(verifySchema(db).ok).toBe(true);
    migrate(db);
    expect(verifySchema(db).ok).toBe(true);
  });

  it('is safe to run twice', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(LEGACY_RUNS);
    db.exec(SCHEMA);
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(verifySchema(db).ok).toBe(true);
  });

  it('declares only additive, non-destructive changes', () => {
    for (const m of expectedColumns()) {
      expect(m.definition.toUpperCase()).not.toContain('NOT NULL');
      expect(m.definition.toUpperCase()).not.toContain('DROP');
      expect(m.note.length).toBeGreaterThan(5);
    }
  });
});

describe('round-tripping a run', () => {
  const record = (): RunRecord => ({
    id: 'run_1',
    createdAt: 1,
    updatedAt: 1,
    prompt: 'Preserve me: $\\frac{1}{2}$ 👍🏽 سلام',
    title: 'test',
    status: 'done',
    outcome: 'converged',
    settings: DEFAULT_RUN_SETTINGS,
    classification: { type: 'factual', confidence: 0.9, rationale: 'r', source: 'heuristic' },
    seatIds: ['a'],
    primarySeatId: 'a',
    rounds: [
      {
        round: 1,
        letters: { a: 'A' },
        critics: { a: [] },
        stateHash: 'h',
        consensus: { equivalent: true, judge: 'structured', camps: [] },
        startedAt: 1,
        finishedAt: 2,
      },
    ],
    seats: {
      a: {
        seatId: 'a',
        displayName: 'A',
        adapter: 'mock',
        family: 'mock',
        status: 'healthy',
        answer: 'ans',
        answerKey: 'k',
        flips: 0,
        agreedRounds: [1],
        messagesUsed: 1,
      },
    },
    finalAnswer: 'ans',
    finalAnswerKey: 'k',
    templateSnapshot: { dispatch: 'body' },
    verification: {
      perSeat: [],
      confidence: 0.81,
      band: 'high',
      factors: [{ name: 'panel agreement', contribution: 0.18, detail: 'all agree' }],
      summary: 'looks solid',
    },
    stats: {
      calls: 1,
      failedCalls: 0,
      rounds: 1,
      wallMs: 10,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      messagesPerSeat: { a: 1 },
    },
  });

  it('survives a save/load cycle including the verification report', () => {
    const store = new Store(':memory:');
    store.saveRun(record());

    const loaded = store.getRun('run_1');
    expect(loaded).not.toBeNull();
    expect(loaded!.verification?.confidence).toBe(0.81);
    expect(loaded!.verification?.band).toBe('high');
    expect(loaded!.rounds).toHaveLength(1);
    expect(loaded!.seats.a?.answerKey).toBe('k');
    store.close();
  });

  it('preserves the prompt byte-for-byte through persistence', () => {
    const store = new Store(':memory:');
    const original = record();
    store.saveRun(original);
    expect(store.getRun('run_1')!.prompt).toBe(original.prompt);
    store.close();
  });

  it('lists interrupted runs so a crash is visible at boot', () => {
    const store = new Store(':memory:');
    const running = { ...record(), id: 'run_2', status: 'running' as const };
    store.saveRun(running);
    expect(store.findResumable()).toContain('run_2');
    store.close();
  });
});
