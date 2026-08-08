import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

/**
 * `node:sqlite` is loaded through createRequire rather than a static import.
 *
 * It is a genuine Node builtin (22.5+), but it postdates the builtin list in
 * some bundlers' resolvers, which then try to find "sqlite" on disk and fail.
 * Going through createRequire keeps it a plain runtime lookup, so the engine
 * and the test runner both load it the same way.
 *
 * Using the builtin at all is the point: persistence with no native module to
 * compile, on a machine that may have no build toolchain at all.
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

import type {
  AuditEntry,
  RoundRecord,
  RunRecord,
  RunSeatState,
  ScoreboardEntry,
  SeatTurn,
} from '@consensus/shared';

import { CONFIG, ensureDataDir } from '../config.js';
import { logger } from '../util/logger.js';
import { migrate, verifySchema } from './migrate.js';
import { SCHEMA } from './schema.js';

const log = logger('store');

const j = (v: unknown): string => JSON.stringify(v ?? null);
const p = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string' || s.length === 0) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

type Row = Record<string, unknown>;

export class Store {
  private db: DatabaseSyncType;

  constructor(path = CONFIG.dbPath) {
    ensureDataDir();
    this.db = new DatabaseSync(path);

    // Order matters: the schema creates anything missing, then migrations add
    // columns to tables that already existed from an earlier version.
    this.db.exec(SCHEMA);
    migrate(this.db);

    const check = verifySchema(this.db);
    if (!check.ok) {
      log.error(
        `the database is missing ${check.missing.join(', ')} — writes touching those columns will fail. ` +
          `Move ${path} aside to start fresh if this persists.`,
      );
    }

    log.info(`run store ready at ${path}`);
  }

  close(): void {
    this.db.close();
  }

  /* ------------------------------------------------------------------ runs */

  saveRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, created_at, updated_at, title, prompt, status, outcome,
            settings_json, classification_json, seat_ids_json, primary_seat_id,
            final_answer, final_answer_key, template_snapshot_json, stats_json,
            verification_json, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
            updated_at=excluded.updated_at, title=excluded.title, status=excluded.status,
            outcome=excluded.outcome, settings_json=excluded.settings_json,
            classification_json=excluded.classification_json, seat_ids_json=excluded.seat_ids_json,
            primary_seat_id=excluded.primary_seat_id, final_answer=excluded.final_answer,
            final_answer_key=excluded.final_answer_key,
            template_snapshot_json=excluded.template_snapshot_json,
            stats_json=excluded.stats_json, verification_json=excluded.verification_json,
            error=excluded.error`,
      )
      .run(
        run.id,
        run.createdAt,
        Date.now(),
        run.title,
        run.prompt,
        run.status,
        run.outcome,
        j(run.settings),
        j(run.classification),
        j(run.seatIds),
        run.primarySeatId,
        run.finalAnswer,
        run.finalAnswerKey,
        j(run.templateSnapshot),
        j(run.stats),
        run.verification ? j(run.verification) : null,
        run.error ?? null,
      );

    for (const round of run.rounds) this.saveRound(run.id, round);
    for (const seat of Object.values(run.seats)) this.saveRunSeat(run.id, seat);
  }

  saveRound(runId: string, round: RoundRecord): void {
    this.db
      .prepare(
        `INSERT INTO rounds (run_id, round, letters_json, critics_json, state_hash,
            consensus_json, started_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id, round) DO UPDATE SET
            letters_json=excluded.letters_json, critics_json=excluded.critics_json,
            state_hash=excluded.state_hash, consensus_json=excluded.consensus_json,
            finished_at=excluded.finished_at`,
      )
      .run(
        runId,
        round.round,
        j(round.letters),
        j(round.critics),
        round.stateHash,
        j(round.consensus),
        round.startedAt,
        round.finishedAt ?? null,
      );
  }

  saveRunSeat(runId: string, seat: RunSeatState): void {
    this.db
      .prepare(
        `INSERT INTO run_seats (run_id, seat_id, display_name, adapter, family, status,
            answer, answer_key, flips, agreed_rounds_json, dropped_at_round, drop_reason,
            messages_used, lossy)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id, seat_id) DO UPDATE SET
            status=excluded.status, answer=excluded.answer, answer_key=excluded.answer_key,
            flips=excluded.flips, agreed_rounds_json=excluded.agreed_rounds_json,
            dropped_at_round=excluded.dropped_at_round, drop_reason=excluded.drop_reason,
            messages_used=excluded.messages_used, lossy=excluded.lossy`,
      )
      .run(
        runId,
        seat.seatId,
        seat.displayName,
        seat.adapter,
        seat.family,
        seat.status,
        seat.answer,
        seat.answerKey,
        seat.flips,
        j(seat.agreedRounds),
        seat.droppedAtRound ?? null,
        seat.dropReason ?? null,
        seat.messagesUsed,
        seat.lossy ? 1 : 0,
      );
  }

  /** Written the moment a call finishes, so a crash loses at most one turn. */
  saveTurn(turn: SeatTurn): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO turns (id, run_id, round, seat_id, kind, letter, prompt_hash,
            prompt, raw, verdict_json, parse_source, answer, answer_key, answer_hash,
            latency_ms, tokens_in, tokens_out, cost_usd, failure_json, lossy, started_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        turn.id,
        turn.runId,
        turn.round,
        turn.seatId,
        turn.kind,
        turn.letter ?? null,
        turn.promptHash,
        turn.prompt,
        turn.raw,
        turn.verdict ? j(turn.verdict) : null,
        turn.parseSource ?? null,
        turn.answer ?? null,
        turn.answerKey ?? null,
        turn.answerHash ?? null,
        turn.latencyMs,
        turn.tokens?.in ?? null,
        turn.tokens?.out ?? null,
        turn.costUsd ?? null,
        turn.failure ? j(turn.failure) : null,
        turn.lossy ? 1 : 0,
        turn.startedAt,
        turn.finishedAt,
      );
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;

    const rounds = (this.db
      .prepare('SELECT * FROM rounds WHERE run_id = ? ORDER BY round')
      .all(id) as Row[]).map(
      (r): RoundRecord => ({
        round: Number(r.round),
        letters: p(r.letters_json, {} as Record<string, string>),
        critics: p(r.critics_json, {} as Record<string, string[]>),
        stateHash: String(r.state_hash ?? ''),
        consensus: p(r.consensus_json, null),
        startedAt: Number(r.started_at),
        finishedAt: r.finished_at === null ? undefined : Number(r.finished_at),
      }),
    );

    const seats: Record<string, RunSeatState> = {};
    for (const s of this.db.prepare('SELECT * FROM run_seats WHERE run_id = ?').all(id) as Row[]) {
      seats[String(s.seat_id)] = {
        seatId: String(s.seat_id),
        displayName: String(s.display_name),
        adapter: s.adapter as RunSeatState['adapter'],
        family: s.family as RunSeatState['family'],
        status: s.status as RunSeatState['status'],
        answer: (s.answer as string) ?? null,
        answerKey: (s.answer_key as string) ?? null,
        flips: Number(s.flips),
        agreedRounds: p(s.agreed_rounds_json, [] as number[]),
        droppedAtRound: s.dropped_at_round === null ? undefined : Number(s.dropped_at_round),
        dropReason: (s.drop_reason as RunSeatState['dropReason']) ?? undefined,
        messagesUsed: Number(s.messages_used),
        lossy: Number(s.lossy) === 1,
      };
    }

    return {
      id: String(row.id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      title: String(row.title),
      prompt: String(row.prompt),
      status: row.status as RunRecord['status'],
      outcome: (row.outcome as RunRecord['outcome']) ?? null,
      settings: p(row.settings_json, {} as RunRecord['settings']),
      classification: p(row.classification_json, null),
      seatIds: p(row.seat_ids_json, [] as string[]),
      primarySeatId: (row.primary_seat_id as string) ?? null,
      finalAnswer: (row.final_answer as string) ?? null,
      finalAnswerKey: (row.final_answer_key as string) ?? null,
      templateSnapshot: p(row.template_snapshot_json, {} as Record<string, string>),
      verification: p(row.verification_json, null),
      stats: p(row.stats_json, {} as RunRecord['stats']),
      error: (row.error as string) ?? undefined,
      rounds,
      seats,
    };
  }

  getTurns(runId: string): SeatTurn[] {
    return (this.db
      .prepare('SELECT * FROM turns WHERE run_id = ? ORDER BY started_at')
      .all(runId) as Row[]).map(
      (t): SeatTurn => ({
        id: String(t.id),
        runId: String(t.run_id),
        round: Number(t.round),
        seatId: String(t.seat_id),
        kind: t.kind as SeatTurn['kind'],
        letter: (t.letter as string) ?? undefined,
        promptHash: String(t.prompt_hash),
        prompt: String(t.prompt),
        raw: String(t.raw),
        verdict: p(t.verdict_json, undefined),
        parseSource: (t.parse_source as SeatTurn['parseSource']) ?? undefined,
        answer: (t.answer as string) ?? undefined,
        answerKey: (t.answer_key as string) ?? undefined,
        answerHash: (t.answer_hash as string) ?? undefined,
        latencyMs: Number(t.latency_ms),
        tokens: { in: (t.tokens_in as number) ?? undefined, out: (t.tokens_out as number) ?? undefined },
        costUsd: (t.cost_usd as number) ?? undefined,
        failure: p(t.failure_json, undefined),
        lossy: Number(t.lossy) === 1,
        startedAt: Number(t.started_at),
        finishedAt: Number(t.finished_at),
      }),
    );
  }

  listRuns(limit = 50): Array<Pick<RunRecord, 'id' | 'title' | 'createdAt' | 'status' | 'outcome'>> {
    return (this.db
      .prepare('SELECT id, title, created_at, status, outcome FROM runs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Row[]).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      createdAt: Number(r.created_at),
      status: r.status as RunRecord['status'],
      outcome: (r.outcome as RunRecord['outcome']) ?? null,
    }));
  }

  deleteRun(id: string): void {
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
  }

  /** Runs that were interrupted. A crashed run must be resumable. */
  findResumable(): string[] {
    return (this.db
      .prepare(`SELECT id FROM runs WHERE status IN ('running','awaiting_approval','paused','queued')`)
      .all() as Row[]).map((r) => String(r.id));
  }

  /* ------------------------------------------------------------ scoreboard */

  bumpScoreboard(entry: {
    seatId: string;
    displayName: string;
    runs?: number;
    correctFirst?: number;
    overruled?: number;
    persuaded?: number;
    flips?: number;
    talkedOutOfCorrect?: number;
    withdrawals?: number;
    nonCompliant?: number;
    latencyMs?: number;
    latencySamples?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO scoreboard (seat_id, display_name, runs, correct_first, overruled, persuaded,
            flips, talked_out_of_correct, withdrawals, non_compliant, latency_total_ms,
            latency_samples, last_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(seat_id) DO UPDATE SET
            display_name = excluded.display_name,
            runs = runs + excluded.runs,
            correct_first = correct_first + excluded.correct_first,
            overruled = overruled + excluded.overruled,
            persuaded = persuaded + excluded.persuaded,
            flips = flips + excluded.flips,
            talked_out_of_correct = talked_out_of_correct + excluded.talked_out_of_correct,
            withdrawals = withdrawals + excluded.withdrawals,
            non_compliant = non_compliant + excluded.non_compliant,
            latency_total_ms = latency_total_ms + excluded.latency_total_ms,
            latency_samples = latency_samples + excluded.latency_samples,
            last_seen = excluded.last_seen`,
      )
      .run(
        entry.seatId,
        entry.displayName,
        entry.runs ?? 0,
        entry.correctFirst ?? 0,
        entry.overruled ?? 0,
        entry.persuaded ?? 0,
        entry.flips ?? 0,
        entry.talkedOutOfCorrect ?? 0,
        entry.withdrawals ?? 0,
        entry.nonCompliant ?? 0,
        entry.latencyMs ?? 0,
        entry.latencySamples ?? 0,
        Date.now(),
      );
  }

  scoreboard(): ScoreboardEntry[] {
    return (this.db.prepare('SELECT * FROM scoreboard ORDER BY runs DESC').all() as Row[]).map((r) => ({
      seatId: String(r.seat_id),
      displayName: String(r.display_name),
      runs: Number(r.runs),
      correctFirst: Number(r.correct_first),
      overruled: Number(r.overruled),
      persuaded: Number(r.persuaded),
      flips: Number(r.flips),
      talkedOutOfCorrect: Number(r.talked_out_of_correct),
      withdrawals: Number(r.withdrawals),
      nonCompliant: Number(r.non_compliant),
      avgLatencyMs: Number(r.latency_samples) ? Math.round(Number(r.latency_total_ms) / Number(r.latency_samples)) : 0,
      lastSeen: Number(r.last_seen),
    }));
  }

  /* ---------------------------------------------------------------- budget */

  recordMessage(seatId: string, at = Date.now()): void {
    this.db.prepare('INSERT INTO budget_history (seat_id, at) VALUES (?, ?)').run(seatId, at);
  }

  loadBudgetHistory(sinceMs: number): Record<string, number[]> {
    const rows = this.db
      .prepare('SELECT seat_id, at FROM budget_history WHERE at >= ? ORDER BY at')
      .all(sinceMs) as Row[];
    const out: Record<string, number[]> = {};
    for (const r of rows) {
      const id = String(r.seat_id);
      (out[id] ??= []).push(Number(r.at));
    }
    return out;
  }

  pruneBudgetHistory(before: number): void {
    this.db.prepare('DELETE FROM budget_history WHERE at < ?').run(before);
  }

  /* ----------------------------------------------------------------- audit */

  appendAudit(entry: AuditEntry): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO audit_log (seq, at, actor, seat_id, run_id, action, target, detail, ok, prev_hash, hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        entry.seq,
        entry.at,
        entry.actor,
        entry.seatId ?? null,
        entry.runId ?? null,
        entry.action,
        entry.target ?? null,
        entry.detail ?? null,
        entry.ok ? 1 : 0,
        entry.prevHash,
        entry.hash,
      );
  }

  auditTail(limit = 200): AuditEntry[] {
    return (this.db
      .prepare('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?')
      .all(limit) as Row[])
      .map((r) => ({
        seq: Number(r.seq),
        at: Number(r.at),
        actor: r.actor as AuditEntry['actor'],
        seatId: (r.seat_id as string) ?? undefined,
        runId: (r.run_id as string) ?? undefined,
        action: String(r.action),
        target: (r.target as string) ?? undefined,
        detail: (r.detail as string) ?? undefined,
        ok: Number(r.ok) === 1,
        prevHash: String(r.prev_hash),
        hash: String(r.hash),
      }))
      .reverse();
  }
}
