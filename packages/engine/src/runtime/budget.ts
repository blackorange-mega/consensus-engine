import type { PreflightEstimate, RunSettings, SeatConfig } from '@consensus/shared';

import { CONFIG } from '../config.js';
import { logger } from '../util/logger.js';

const log = logger('budget');

/**
 * Message budgeting.
 *
 * The binding constraint on this app is not money and not wall-clock — it is
 * per-seat subscription quota. Each seat takes roughly `calls/N` messages per
 * run, which against consumer caps leaves room for something like 6-12 runs in
 * a 5-hour window, shared with the user's normal use of that product.
 *
 * So: estimate before the run, enforce during it, and treat exhaustion as a
 * normal circuit-breaker drop rather than an error.
 */

interface Usage {
  /** Timestamps of messages sent, for the rolling daily window. */
  history: number[];
  run: number;
}

export class BudgetLedger {
  private usage = new Map<string, Usage>();

  private get(seatId: string): Usage {
    let u = this.usage.get(seatId);
    if (!u) {
      u = { history: [], run: 0 };
      this.usage.set(seatId, u);
    }
    return u;
  }

  private prune(u: Usage, now: number): void {
    const cutoff = now - CONFIG.budgetWindowMs;
    if (u.history.length && u.history[0]! < cutoff) {
      u.history = u.history.filter((t) => t >= cutoff);
    }
  }

  startRun(seatIds: string[]): void {
    for (const id of seatIds) this.get(id).run = 0;
  }

  used(seatId: string, now = Date.now()): { run: number; day: number } {
    const u = this.get(seatId);
    this.prune(u, now);
    return { run: u.run, day: u.history.length };
  }

  remainingToday(seat: SeatConfig, now = Date.now()): number | null {
    const cap = seat.budget?.perDay;
    if (cap === undefined) return null;
    return Math.max(0, cap - this.used(seat.id, now).day);
  }

  /** Can this seat take one more message right now? */
  check(
    seat: SeatConfig,
    settings: RunSettings,
    now = Date.now(),
  ): { ok: true } | { ok: false; scope: 'run' | 'day'; detail: string } {
    const { run, day } = this.used(seat.id, now);
    const runCap = seat.budget?.perRun ?? settings.perSeatRunBudget;
    if (runCap !== undefined && run >= runCap) {
      return { ok: false, scope: 'run', detail: `per-run budget of ${runCap} messages reached` };
    }
    const dayCap = seat.budget?.perDay;
    if (dayCap !== undefined && day >= dayCap) {
      return { ok: false, scope: 'day', detail: `daily budget of ${dayCap} messages reached` };
    }
    return { ok: true };
  }

  record(seatId: string, now = Date.now()): void {
    const u = this.get(seatId);
    u.run++;
    u.history.push(now);
    this.prune(u, now);
  }

  /** Persisted across restarts so a daily cap survives closing the app. */
  serialise(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const [id, u] of this.usage) out[id] = u.history;
    return out;
  }

  restore(data: Record<string, number[]>): void {
    const now = Date.now();
    for (const [id, history] of Object.entries(data)) {
      const u = this.get(id);
      u.history = history.filter((t) => t >= now - CONFIG.budgetWindowMs);
    }
    log.info(`restored message history for ${Object.keys(data).length} seats`);
  }
}

/**
 * Pre-flight estimate shown before the run starts:
 * "this will use ~5 messages from each of 4 seats."
 *
 *   calls = N + 2N(R-1) + N        worst case, split judge/revise, final rewrite
 *
 * Pruning reduces this materially — roughly 20-25% at a 35% concede rate — so
 * the expected figure is reported alongside the worst case.
 */
export function preflight(
  seats: SeatConfig[],
  settings: RunSettings,
  ledger: BudgetLedger,
  opts: { assumedConcedeRate?: number; secondsPerStep?: [number, number] } = {},
): PreflightEstimate {
  const n = seats.length;
  const r = settings.maxRounds;
  const concede = opts.assumedConcedeRate ?? 0.35;
  const [fastStep, slowStep] = opts.secondsPerStep ?? [30, 60];

  const debateCalls = 2 * n * Math.max(0, r - 1);
  const rewriteCalls = settings.finalRewrite ? n : 0;

  // Verification is opt-in and spends real messages, so it belongs in the
  // estimate rather than surprising the user after the fact. Self-consistency
  // resamples every surviving seat; the cross-check is a single review.
  const selfConsistencyCalls = Math.max(0, settings.selfConsistencySamples ?? 0) * n;
  const crossCheckCalls = settings.crossCheck ? 1 : 0;
  const verificationCalls = selfConsistencyCalls + crossCheckCalls;

  const worstCaseCalls = n + debateCalls + rewriteCalls + verificationCalls;

  // Each round, a fraction of edges concede and drop out of the next round's
  // prompts; seats with no critics left skip their revise call entirely.
  let expectedDebate = 0;
  let activeFraction = 1;
  for (let round = 2; round <= r; round++) {
    expectedDebate += n * activeFraction; // judge calls
    expectedDebate += n * activeFraction; // revise calls
    activeFraction *= 1 - concede;
  }
  const expectedCalls = Math.round(n + expectedDebate + rewriteCalls + verificationCalls);

  const stepsPerRound = 2;
  const verificationSteps =
    (settings.selfConsistencySamples > 0 ? 1 : 0) + (settings.crossCheck ? 1 : 0);
  const serialSteps =
    1 + Math.max(0, r - 1) * stepsPerRound + (settings.finalRewrite ? 1 : 0) + verificationSteps;

  const messagesPerSeat = n === 0 ? 0 : Math.ceil(expectedCalls / n);

  const warnings: string[] = [];
  const perSeat = seats.map((seat) => {
    const remaining = ledger.remainingToday(seat);
    const willExhaust = remaining !== null && remaining < messagesPerSeat;
    if (willExhaust) {
      warnings.push(
        `${seat.displayName} has ${remaining} message(s) left in its daily budget but this run needs about ${messagesPerSeat}`,
      );
    }
    return {
      seatId: seat.id,
      displayName: seat.displayName,
      messages: messagesPerSeat,
      remainingToday: remaining,
      willExhaust,
    };
  });

  if (n < 2) warnings.push('a panel of fewer than two seats cannot cross-examine anything');
  if (n >= 2 && r >= 4) {
    warnings.push(
      'at four rounds the tightest subscription seat allows roughly six runs per five-hour window, ' +
        'and that quota is shared with your normal use of that product',
    );
  }

  return {
    seats: n,
    rounds: r,
    worstCaseCalls,
    expectedCalls,
    messagesPerSeat,
    serialSteps,
    estimatedMinutes: [
      Number(((serialSteps * fastStep) / 60).toFixed(1)),
      Number(((serialSteps * slowStep) / 60).toFixed(1)),
    ],
    perSeat,
    warnings,
  };
}
