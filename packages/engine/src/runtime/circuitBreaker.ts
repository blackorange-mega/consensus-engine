import type { SeatFailureReason, SeatStatus } from '@consensus/shared';

import { isRetryable } from '../adapters/types.js';
import { logger } from '../util/logger.js';

const log = logger('breaker');

/**
 * Per-seat circuit breaker: healthy -> degraded (retrying with
 * backoff) -> dropped.
 *
 * On drop the seat's last answer is frozen and kept on screen, it is marked
 * "withdrew at round N", it is excluded from further rounds, and quorum is
 * recomputed for the smaller panel — graceful shrinkage, not failure.
 * A mid-run rate limit shrinks the panel; it does not fail the run.
 */

export interface BreakerConfig {
  /** Consecutive retryable failures before the seat is dropped. */
  failureThreshold: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = {
  failureThreshold: 3,
  baseBackoffMs: 2_000,
  maxBackoffMs: 60_000,
};

/** Failures that are terminal for the run: retrying cannot help. */
const TERMINAL: ReadonlySet<SeatFailureReason> = new Set<SeatFailureReason>([
  'usage_cap',
  'login_expired',
  'challenge',
  'not_configured',
  'budget_exhausted',
  'aborted',
]);

export interface SeatBreakerState {
  seatId: string;
  status: SeatStatus;
  consecutiveFailures: number;
  lastFailure?: { reason: SeatFailureReason; detail?: string; at: number };
  droppedAtRound?: number;
  dropReason?: SeatFailureReason;
  /** Not eligible to be called again until this timestamp. */
  cooldownUntil?: number;
}

export class CircuitBreaker {
  private states = new Map<string, SeatBreakerState>();

  constructor(private readonly cfg: BreakerConfig = DEFAULT_BREAKER) {}

  register(seatId: string): void {
    if (!this.states.has(seatId)) {
      this.states.set(seatId, { seatId, status: 'healthy', consecutiveFailures: 0 });
    }
  }

  state(seatId: string): SeatBreakerState {
    this.register(seatId);
    return this.states.get(seatId)!;
  }

  all(): SeatBreakerState[] {
    return [...this.states.values()];
  }

  alive(): string[] {
    return this.all()
      .filter((s) => s.status !== 'dropped')
      .map((s) => s.seatId);
  }

  isDropped(seatId: string): boolean {
    return this.state(seatId).status === 'dropped';
  }

  /** True when the seat is inside its backoff window and should be skipped for now. */
  isCoolingDown(seatId: string, now = Date.now()): boolean {
    const s = this.state(seatId);
    return s.status === 'degraded' && Boolean(s.cooldownUntil && s.cooldownUntil > now);
  }

  backoffFor(seatId: string): number {
    const s = this.state(seatId);
    const delay = this.cfg.baseBackoffMs * 2 ** Math.max(0, s.consecutiveFailures - 1);
    return Math.min(this.cfg.maxBackoffMs, delay);
  }

  recordSuccess(seatId: string): SeatStatus {
    const s = this.state(seatId);
    if (s.status === 'dropped') return 'dropped';
    if (s.consecutiveFailures > 0) {
      log.info(`${seatId} recovered after ${s.consecutiveFailures} failure(s)`);
    }
    s.consecutiveFailures = 0;
    s.status = 'healthy';
    delete s.cooldownUntil;
    return s.status;
  }

  /**
   * Record a failure and decide the seat's fate.
   * Non-retryable reasons drop immediately: there is no point backing off from
   * an exhausted quota or an expired login.
   */
  recordFailure(
    seatId: string,
    reason: SeatFailureReason,
    round: number,
    detail?: string,
  ): { status: SeatStatus; dropped: boolean; cooldownMs: number } {
    const s = this.state(seatId);
    if (s.status === 'dropped') return { status: 'dropped', dropped: false, cooldownMs: 0 };

    s.consecutiveFailures++;
    s.lastFailure = { reason, detail, at: Date.now() };

    const terminal = TERMINAL.has(reason) || !isRetryable(reason);
    const exhausted = s.consecutiveFailures >= this.cfg.failureThreshold;

    if (terminal || exhausted) {
      s.status = 'dropped';
      s.droppedAtRound = round;
      s.dropReason = reason;
      log.warn(
        `${seatId} dropped at round ${round}: ${reason}${detail ? ` (${detail.slice(0, 120)})` : ''}`,
      );
      return { status: 'dropped', dropped: true, cooldownMs: 0 };
    }

    s.status = 'degraded';
    const cooldownMs = this.backoffFor(seatId);
    s.cooldownUntil = Date.now() + cooldownMs;
    log.warn(`${seatId} degraded (${reason}); retrying in ${cooldownMs}ms`);
    return { status: 'degraded', dropped: false, cooldownMs };
  }

  /** Manual drop, e.g. the user removing a seat mid-run. */
  drop(seatId: string, round: number, reason: SeatFailureReason = 'aborted'): void {
    const s = this.state(seatId);
    if (s.status === 'dropped') return;
    s.status = 'dropped';
    s.droppedAtRound = round;
    s.dropReason = reason;
  }

  /**
   * Quorum for the current panel size. Below two surviving seats there is no
   * cross-examination left to do, so the run ends and reports.
   */
  hasQuorum(): boolean {
    return this.alive().length >= 2;
  }
}
