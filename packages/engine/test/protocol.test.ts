import { describe, expect, it } from 'vitest';

import { assignLetters, seatByLetter } from '@consensus/shared';

import { classifyHeuristic, isDebatable } from '../src/protocol/classify.js';
import { newOscillationState, recordRound } from '../src/protocol/oscillation.js';
import { computeCritics, contestedSeats, pruningSavings } from '../src/protocol/pruning.js';
import { CircuitBreaker } from '../src/runtime/circuitBreaker.js';
import { AuditLog } from '../src/runtime/audit.js';
import { BudgetLedger, preflight } from '../src/runtime/budget.js';
import { DEFAULT_RUN_SETTINGS, type SeatConfig } from '@consensus/shared';

describe('expert letters', () => {
  it('assigns one letter per seat', () => {
    const letters = assignLetters(['a', 'b', 'c', 'd'], 'run1', 1);
    expect(new Set(Object.values(letters)).size).toBe(4);
  });

  it('reshuffles between rounds so nobody is permanently Expert A', () => {
    const seats = ['a', 'b', 'c', 'd'];
    const seen = new Set<string>();
    for (let round = 1; round <= 8; round++) {
      seen.add(assignLetters(seats, 'run1', round).a!);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('is deterministic, so a run can be replayed exactly', () => {
    expect(assignLetters(['a', 'b', 'c'], 'run1', 2)).toEqual(assignLetters(['a', 'b', 'c'], 'run1', 2));
  });

  it('ignores the input ordering of seat ids', () => {
    expect(assignLetters(['c', 'a', 'b'], 'r', 1)).toEqual(assignLetters(['a', 'b', 'c'], 'r', 1));
  });

  it('inverts cleanly', () => {
    const letters = assignLetters(['a', 'b'], 'r', 1);
    const inverted = seatByLetter(letters);
    expect(inverted[letters.a!]).toBe('a');
  });
});

describe('adaptive pruning', () => {
  const letters = { a: 'A', b: 'B', c: 'C' };

  it('drops a critic once it concedes', () => {
    const { critics } = computeCritics({
      seatIds: ['a', 'b', 'c'],
      letters,
      verdicts: {
        // b says a is right, c is wrong
        b: { agree: false, critiques: { A: null, C: 'wrong' } },
        // c says a is wrong
        c: { agree: false, critiques: { A: 'wrong', B: null } },
        a: { agree: true },
      },
    });

    expect(critics.a).toEqual(['c']); // b conceded and dropped out
    expect(critics.c).toEqual(['b']);
    expect(critics.b).toEqual([]);
  });

  it('treats an unspecific disagreement as an objection to everyone', () => {
    const { critics, unspecific } = computeCritics({
      seatIds: ['a', 'b'],
      letters,
      verdicts: { a: { agree: false }, b: { agree: true } },
    });
    expect(unspecific).toEqual(['a']);
    expect(critics.b).toEqual(['a']);
  });

  it('gives a seat with no usable reply no vote in either direction', () => {
    const { critics } = computeCritics({
      seatIds: ['a', 'b'],
      letters,
      verdicts: { a: undefined, b: { agree: true } },
    });
    expect(critics.a).toEqual([]);
    expect(critics.b).toEqual([]);
  });

  it('identifies the contested seats', () => {
    expect(contestedSeats({ a: ['b'], b: [], c: ['a', 'b'] })).toEqual(['a', 'c']);
  });

  it('measures how much context pruning saved', () => {
    const saving = pruningSavings({ a: [], b: ['a'], c: ['a'] }, 3);
    expect(saving.edgesTotal).toBe(6);
    expect(saving.edgesKept).toBe(2);
    expect(saving.savedFraction).toBeCloseTo(2 / 3);
  });
});

describe('oscillation detection', () => {
  it('does not fire while the panel is still moving', () => {
    const state = newOscillationState();
    expect(recordRound(state, ['5', '6']).oscillating).toBe(false);
    expect(recordRound(state, ['5', '5']).oscillating).toBe(false);
  });

  it('fires when the panel returns to an earlier state', () => {
    const state = newOscillationState();
    recordRound(state, ['5', '6']);
    recordRound(state, ['6', '5']); // same multiset -> already a repeat
    const third = recordRound(state, ['5', '6']);
    expect(third.oscillating).toBe(true);
    expect(third.repeatOfRound).toBeDefined();
  });

  it('is order-independent, since seat order carries no meaning', () => {
    const a = newOscillationState();
    const b = newOscillationState();
    expect(recordRound(a, ['x', 'y']).hash).toBe(recordRound(b, ['y', 'x']).hash);
  });
});

describe('circuit breaker', () => {
  it('drops immediately on a non-retryable failure', () => {
    const breaker = new CircuitBreaker();
    breaker.register('s1');
    const result = breaker.recordFailure('s1', 'usage_cap', 2);
    expect(result.dropped).toBe(true);
    expect(breaker.state('s1').droppedAtRound).toBe(2);
  });

  it('degrades with backoff before dropping on repeated retryable failures', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, baseBackoffMs: 10, maxBackoffMs: 100 });
    breaker.register('s1');
    expect(breaker.recordFailure('s1', 'network', 1).status).toBe('degraded');
    expect(breaker.recordFailure('s1', 'network', 1).status).toBe('degraded');
    expect(breaker.recordFailure('s1', 'network', 1).dropped).toBe(true);
  });

  it('recovers after a success', () => {
    const breaker = new CircuitBreaker();
    breaker.register('s1');
    breaker.recordFailure('s1', 'network', 1);
    expect(breaker.recordSuccess('s1')).toBe('healthy');
    expect(breaker.state('s1').consecutiveFailures).toBe(0);
  });

  it('loses quorum below two surviving seats', () => {
    const breaker = new CircuitBreaker();
    ['a', 'b', 'c'].forEach((id) => breaker.register(id));
    expect(breaker.hasQuorum()).toBe(true);
    breaker.drop('a', 1);
    expect(breaker.hasQuorum()).toBe(true);
    breaker.drop('b', 1);
    expect(breaker.hasQuorum()).toBe(false);
  });
});

describe('task-type gating', () => {
  it('routes verifiable prompts into the debate', () => {
    expect(isDebatable(classifyHeuristic('What is 17 * 24?'), false)).toBe(true);
    expect(isDebatable(classifyHeuristic('What is the capital of Australia?'), false)).toBe(true);
  });

  it('keeps creative and opinion prompts out of it', () => {
    expect(classifyHeuristic('Write me a poem about the sea').type).toBe('creative');
    expect(isDebatable(classifyHeuristic('Write me a poem about the sea'), false)).toBe(false);
    expect(isDebatable(classifyHeuristic('What do you think is the best programming language?'), false)).toBe(false);
  });

  it('honours the user override', () => {
    expect(isDebatable(classifyHeuristic('Write me a poem'), true)).toBe(true);
  });

  it('detects code prompts', () => {
    expect(classifyHeuristic('Why does this function throw?\n```js\nfoo()\n```').type).toBe('code');
  });
});

describe('budget ledger', () => {
  const seat: SeatConfig = {
    id: 's1',
    displayName: 'S1',
    adapter: 'mock',
    enabled: true,
    options: {},
    budget: { perRun: 2, perDay: 3 },
  };

  it('enforces the per-run cap', () => {
    const ledger = new BudgetLedger();
    ledger.startRun(['s1']);
    ledger.record('s1');
    ledger.record('s1');
    const check = ledger.check(seat, DEFAULT_RUN_SETTINGS);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.scope).toBe('run');
  });

  it('enforces the rolling daily cap across runs', () => {
    const ledger = new BudgetLedger();
    ledger.startRun(['s1']);
    ledger.record('s1');
    ledger.record('s1');
    ledger.startRun(['s1']); // new run resets the per-run counter, not the daily one
    ledger.record('s1');
    const check = ledger.check(seat, DEFAULT_RUN_SETTINGS);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.scope).toBe('day');
  });
});

describe('pre-flight estimate', () => {
  const seats: SeatConfig[] = ['a', 'b', 'c', 'd'].map((id) => ({
    id,
    displayName: id.toUpperCase(),
    adapter: 'mock',
    enabled: true,
    options: {},
  }));

  it('matches the worst-case call formula N + 2N(R-1) + N', () => {
    const est = preflight(seats, { ...DEFAULT_RUN_SETTINGS, maxRounds: 4, finalRewrite: true }, new BudgetLedger());
    // N=4, R=4 -> 4 + 24 + 4 = 32
    expect(est.worstCaseCalls).toBe(32);
  });

  it('expects fewer calls than the worst case because of pruning', () => {
    const est = preflight(seats, { ...DEFAULT_RUN_SETTINGS, maxRounds: 4 }, new BudgetLedger());
    expect(est.expectedCalls).toBeLessThan(est.worstCaseCalls);
  });

  it('counts serial steps rather than total calls for wall clock', () => {
    const est = preflight(seats, { ...DEFAULT_RUN_SETTINGS, maxRounds: 4, finalRewrite: false }, new BudgetLedger());
    expect(est.serialSteps).toBe(7);
  });

  it('warns when a panel is too small to cross-examine anything', () => {
    const est = preflight(seats.slice(0, 1), DEFAULT_RUN_SETTINGS, new BudgetLedger());
    expect(est.warnings.join(' ')).toContain('fewer than two seats');
  });
});

describe('audit log', () => {
  it('hash-chains entries so tampering is detectable', () => {
    const log = new AuditLog();
    log.record({ actor: 'engine', action: 'a', ok: true });
    log.record({ actor: 'relay', action: 'b', ok: true });
    expect(log.verify().ok).toBe(true);

    const entries = log.recent();
    expect(entries[1]?.prevHash).toBe(entries[0]?.hash);
  });

  it('detects an edited entry', () => {
    const log = new AuditLog();
    log.record({ actor: 'engine', action: 'a', ok: true });
    log.record({ actor: 'engine', action: 'b', ok: false });
    // Simulate tampering with the stored record.
    const entries = log.recent();
    entries[1]!.ok = true;
    expect(log.verify().ok).toBe(false);
  });
});
