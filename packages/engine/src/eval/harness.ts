import type { RunSettings, SeatConfig, Stubbornness } from '@consensus/shared';
import { DEFAULT_RUN_SETTINGS } from '@consensus/shared';

import { buildPanel } from '../adapters/registry.js';
import type { ModelAdapter } from '../adapters/types.js';
import { Store } from '../db/store.js';
import { compareKeys, normalizeKey } from '../judges/normalize.js';
import { RunExecution } from '../orchestrator.js';
import { extractAnswerAndKey } from '../protocol/parser.js';
import { buildDispatchPrompt } from '../protocol/roundBuilder.js';
import { BudgetLedger } from '../runtime/budget.js';
import { pool } from '../util/async.js';
import { logger } from '../util/logger.js';
import { loadGoldens, oracleFor, type Golden } from './goldens.js';

const log = logger('eval');

/**
 * The evaluation harness.
 *
 * Why it exists, bluntly: the published evidence says multi-agent debate does
 * not reliably beat far cheaper baselines. Smit et al.
 * (ICML 2024) find MAD does not reliably outperform self-consistency or
 * ensembling; Zhang et al. (2025) find it often loses to plain Chain-of-Thought
 * and Self-Consistency across nine benchmarks while burning much more compute.
 *
 * Two findings point the other way and both are load-bearing here:
 *   - model heterogeneity is a "universal antidote" that consistently improves
 *     MAD — and this app is heterogeneous by construction;
 *   - tuning agreement modulation took a losing protocol to state of the art —
 *     which is the stubbornness dial, swept below.
 *
 * So the number that matters is not "is the protocol better than one model".
 * It is "is the protocol better than self-consistency at matched compute". If
 * it is not, the finding is that the protocol needs retuning — not that you
 * should ship it and hope.
 */

export type Condition = 'single' | 'self_consistency' | 'protocol';

export interface EvalOptions {
  seats: SeatConfig[];
  goldens?: Golden[];
  conditions?: Condition[];
  /** Samples per question for the self-consistency baseline. */
  k?: number;
  /** Stubbornness values to sweep. One protocol run per value per question. */
  stubbornnessSweep?: Stubbornness[];
  settings?: Partial<RunSettings>;
  concurrency?: number;
  /** Ground truth for mock seats. Omit when running against real models. */
  useMockOracle?: boolean;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface ConditionResult {
  condition: Condition;
  label: string;
  stubbornness?: Stubbornness;
  total: number;
  correct: number;
  accuracy: number;
  /** Total model calls, so accuracy can be read at matched compute. */
  calls: number;
  callsPerQuestion: number;
  /** Right in round 1, wrong at convergence. The sycophancy counter. */
  talkedOutOfCorrect: number;
  /** Wrong in round 1, right at convergence. What the protocol is for. */
  rescued: number;
  unresolved: number;
  /**
   * Accuracy of the largest camp, including runs that never reached unanimity.
   * Reported separately from `accuracy` because a run that ends unresolved
   * yields no answer by design -- the app does not manufacture a consensus it
   * did not observe -- but "3 of 4 models held X" is still an observed fact and
   * is what the divergence view puts in front of the user.
   */
  majorityCorrect: number;
  majorityAccuracy: number;
  wallMs: number;
}

export interface EvalReport {
  startedAt: number;
  finishedAt: number;
  questions: number;
  seats: string[];
  results: ConditionResult[];
  perQuestion: Array<{
    id: string;
    question: string;
    expected: string;
    byCondition: Record<string, { answer: string; correct: boolean; calls: number }>;
  }>;
  verdict: string;
}

export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const goldens = opts.goldens ?? loadGoldens();
  const conditions = opts.conditions ?? ['single', 'self_consistency', 'protocol'];
  const sweep = opts.stubbornnessSweep ?? [DEFAULT_RUN_SETTINGS.stubbornness];
  const k = opts.k ?? 3;
  const startedAt = Date.now();

  const oracle = opts.useMockOracle ? oracleFor(goldens) : undefined;
  const { adapters } = buildPanel(opts.seats, { mockOracle: oracle });
  if (adapters.size === 0) throw new Error('no usable seats: cannot evaluate anything');

  // A throwaway store so eval runs never pollute the user's real history.
  const store = new Store(':memory:');
  const ledger = new BudgetLedger();

  const perQuestion = goldens.map((g) => ({
    id: g.id,
    question: g.question,
    expected: g.key,
    byCondition: {} as Record<string, { answer: string; correct: boolean; calls: number }>,
  }));

  const results: ConditionResult[] = [];
  const totalUnits =
    goldens.length *
    ((conditions.includes('single') ? 1 : 0) +
      (conditions.includes('self_consistency') ? 1 : 0) +
      (conditions.includes('protocol') ? sweep.length : 0));
  let done = 0;
  const tick = (label: string) => opts.onProgress?.(++done, totalUnits, label);

  /* --------------------------------------------------------- single model */

  if (conditions.includes('single')) {
    const primary = opts.seats.find((s) => s.primary && s.enabled) ?? opts.seats.find((s) => s.enabled)!;
    const adapter = adapters.get(primary.id)!;
    const started = Date.now();
    let correct = 0;
    let calls = 0;

    const outcomes = await pool(
      goldens.map((g) => async () => {
        const answer = await askOnce(adapter, g.question, opts.settings?.callTimeoutMs ?? 120_000);
        tick(`single: ${g.id}`);
        return { g, answer };
      }),
      opts.concurrency ?? 4,
    );

    for (const o of outcomes) {
      if (!o.ok) continue;
      calls++;
      const ok = isCorrect(o.value.answer.key, o.value.g.key);
      if (ok) correct++;
      record(perQuestion, o.value.g.id, 'single', o.value.answer.key, ok, 1);
    }

    results.push(
      summarise('single', `single model (${primary.displayName})`, goldens.length, correct, calls, started, {
        talkedOutOfCorrect: 0,
        rescued: 0,
        unresolved: 0,
      }),
    );
  }

  /* ----------------------------------------------- self-consistency at k --- */

  if (conditions.includes('self_consistency')) {
    const primary = opts.seats.find((s) => s.primary && s.enabled) ?? opts.seats.find((s) => s.enabled)!;
    const adapter = adapters.get(primary.id)!;
    const started = Date.now();
    let correct = 0;
    let calls = 0;

    const outcomes = await pool(
      goldens.map((g) => async () => {
        const samples: string[] = [];
        for (let i = 0; i < k; i++) {
          // Vary the sample without changing the question: temperature where the
          // adapter supports it, otherwise a distinct request each time.
          const a = await askOnce(adapter, g.question, opts.settings?.callTimeoutMs ?? 120_000, i === 0 ? 0 : 0.8);
          samples.push(normalizeKey(a.key));
        }
        tick(`self-consistency: ${g.id}`);
        return { g, winner: majority(samples), n: k };
      }),
      Math.max(1, Math.floor((opts.concurrency ?? 4) / 2)),
    );

    for (const o of outcomes) {
      if (!o.ok) continue;
      calls += o.value.n;
      const ok = isCorrect(o.value.winner, o.value.g.key);
      if (ok) correct++;
      record(perQuestion, o.value.g.id, 'self_consistency', o.value.winner, ok, o.value.n);
    }

    results.push(
      summarise(
        'self_consistency',
        `self-consistency @${k} (${primary.displayName})`,
        goldens.length,
        correct,
        calls,
        started,
        { talkedOutOfCorrect: 0, rescued: 0, unresolved: 0 },
      ),
    );
  }

  /* ------------------------------------------------------------- protocol -- */

  if (conditions.includes('protocol')) {
    for (const stubbornness of sweep) {
      const started = Date.now();
      let correct = 0;
      let calls = 0;
      let talkedOut = 0;
      let rescued = 0;
      let unresolved = 0;
      let majorityCorrect = 0;

      const settings: RunSettings = {
        ...DEFAULT_RUN_SETTINGS,
        ...opts.settings,
        mode: 'auto',
        stubbornness,
        finalRewrite: false,
      };

      const outcomes = await pool(
        goldens.map((g) => async () => {
          const execution = new RunExecution(g.question, settings, {
            store,
            adapters,
            seats: opts.seats,
            ledger,
            emit: () => {},
          });
          const run = await execution.start();
          tick(`protocol s=${stubbornness}: ${g.id}`);
          return { g, run };
        }),
        opts.concurrency ?? 2,
      );

      for (const o of outcomes) {
        if (!o.ok) continue;
        const { g, run } = o.value;
        calls += run.stats.calls;

        const finalKey = run.finalAnswerKey ?? '';
        const ok = isCorrect(finalKey, g.key);
        if (ok) correct++;
        if (run.outcome === 'unresolved' || run.outcome === 'oscillating') unresolved++;

        // The largest camp's claim, whether or not the panel reached unanimity.
        const largestCamp = run.rounds.at(-1)?.consensus?.camps[0];
        if (largestCamp && isCorrect(largestCamp.label, g.key)) majorityCorrect++;

        // Round-1 answers, read back from the turn log rather than from the
        // seats' current state -- by the end of a run those hold the *final*
        // positions, which would make both metrics below measure nothing.
        const firstKeys = store
          .getTurns(run.id)
          .filter((t) => t.round === 1 && t.kind === 'dispatch' && t.answerKey)
          .map((t) => t.answerKey!);

        // "Did the debate help or hurt, relative to what round 1 already knew?"
        // Only runs that actually produced an answer count as being talked out
        // of a correct one -- an unresolved run withheld an answer rather than
        // adopting a wrong one, and is counted under `unresolved` instead.
        const anyRightFirst = firstKeys.some((key) => isCorrect(key, g.key));
        if (anyRightFirst && finalKey && !ok) talkedOut++;
        if (!anyRightFirst && ok) rescued++;

        record(perQuestion, g.id, `protocol_s${stubbornness}`, finalKey, ok, run.stats.calls);
      }

      results.push(
        summarise(
          'protocol',
          `protocol (stubbornness ${stubbornness})`,
          goldens.length,
          correct,
          calls,
          started,
          { talkedOutOfCorrect: talkedOut, rescued, unresolved, majorityCorrect },
          stubbornness,
        ),
      );
    }
  }

  store.close();

  return {
    startedAt,
    finishedAt: Date.now(),
    questions: goldens.length,
    seats: opts.seats.filter((s) => s.enabled).map((s) => s.displayName),
    results,
    perQuestion,
    verdict: verdictFor(results),
  };
}

/* ------------------------------------------------------------------ helpers */

async function askOnce(
  adapter: ModelAdapter,
  question: string,
  timeoutMs: number,
  temperature?: number,
): Promise<{ answer: string; key: string }> {
  const built = buildDispatchPrompt(question, true);
  const res = await adapter.send(built.prompt, { timeoutMs, temperature, newThread: true });
  const { answer, key } = extractAnswerAndKey(res.text);
  return { answer, key: key ?? answer };
}

function isCorrect(actual: string, expected: string): boolean {
  return compareKeys(actual, expected, { tolerance: 1e-6 }).equal;
}

function majority(keys: string[]): string {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

function record(
  perQuestion: EvalReport['perQuestion'],
  id: string,
  condition: string,
  answer: string,
  correct: boolean,
  calls: number,
): void {
  const row = perQuestion.find((q) => q.id === id);
  if (row) row.byCondition[condition] = { answer, correct, calls };
}

function summarise(
  condition: Condition,
  label: string,
  total: number,
  correct: number,
  calls: number,
  started: number,
  extra: { talkedOutOfCorrect: number; rescued: number; unresolved: number; majorityCorrect?: number },
  stubbornness?: Stubbornness,
): ConditionResult {
  const majorityCorrect = extra.majorityCorrect ?? correct;
  return {
    condition,
    label,
    stubbornness,
    total,
    correct,
    accuracy: total ? correct / total : 0,
    calls,
    callsPerQuestion: total ? calls / total : 0,
    talkedOutOfCorrect: extra.talkedOutOfCorrect,
    rescued: extra.rescued,
    unresolved: extra.unresolved,
    majorityCorrect,
    majorityAccuracy: total ? majorityCorrect / total : 0,
    wallMs: Date.now() - started,
  };
}

/**
 * The honest read of the numbers. This says "retune it" rather than "ship it"
 * when the protocol loses — an eval that only ever congratulates you is worthless.
 */
function verdictFor(results: ConditionResult[]): string {
  const single = results.find((r) => r.condition === 'single');
  const sc = results.find((r) => r.condition === 'self_consistency');
  const protocols = results.filter((r) => r.condition === 'protocol');
  if (!protocols.length) return 'No protocol condition was run, so there is nothing to conclude.';

  const best = protocols.reduce((a, b) => (b.accuracy > a.accuracy ? b : a));
  const lines: string[] = [];

  if (single) {
    const delta = (best.accuracy - single.accuracy) * 100;
    lines.push(
      `Against a single model: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} points ` +
        `(${(best.accuracy * 100).toFixed(1)}% vs ${(single.accuracy * 100).toFixed(1)}%), ` +
        `at ${(best.callsPerQuestion / Math.max(single.callsPerQuestion, 0.001)).toFixed(1)}x the calls.`,
    );
  }

  if (best.majorityAccuracy > best.accuracy) {
    lines.push(
      `On ${(((best.majorityAccuracy - best.accuracy) * best.total) | 0)} question(s) the largest camp held the ` +
        `correct claim but the panel never reached unanimity, so no answer was returned. That is the protocol ` +
        `refusing to call a 3-1 split a consensus, which is intended -- but if it happens often, the panel ` +
        `contains a seat that never concedes and the run is paying for rounds that cannot resolve.`,
    );
  }

  if (sc) {
    const delta = (best.accuracy - sc.accuracy) * 100;
    lines.push(
      `Against self-consistency at matched compute — the baseline the literature says usually wins: ` +
        `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} points ` +
        `(${(best.accuracy * 100).toFixed(1)}% vs ${(sc.accuracy * 100).toFixed(1)}%).`,
    );
    if (delta <= 0) {
      lines.push(
        'The protocol does not beat self-consistency here. That is a finding about tuning, not a reason ' +
          'to ship it anyway: sweep the stubbornness dial and check panel heterogeneity before drawing conclusions.',
      );
    }
  }

  if (protocols.length > 1) {
    const ranked = [...protocols].sort((a, b) => b.accuracy - a.accuracy);
    lines.push(
      `Best stubbornness setting: ${ranked[0]!.stubbornness} ` +
        `(${(ranked[0]!.accuracy * 100).toFixed(1)}%), worst: ${ranked.at(-1)!.stubbornness} ` +
        `(${(ranked.at(-1)!.accuracy * 100).toFixed(1)}%).`,
    );
  }

  const worstSycophancy = protocols.reduce((a, b) => (b.talkedOutOfCorrect > a.talkedOutOfCorrect ? b : a));
  if (worstSycophancy.talkedOutOfCorrect > 0) {
    lines.push(
      `Sycophancy: at stubbornness ${worstSycophancy.stubbornness}, the panel was talked out of a correct ` +
        `round-1 answer on ${worstSycophancy.talkedOutOfCorrect}/${worstSycophancy.total} question(s).`,
    );
  }
  if (best.rescued > 0) {
    lines.push(`The debate rescued ${best.rescued}/${best.total} question(s) that no model got right in round 1.`);
  }

  return lines.join('\n');
}

export function evalToMarkdown(report: EvalReport): string {
  const L: string[] = [];
  L.push('# Evaluation report', '');
  L.push(`- Questions: ${report.questions}`);
  L.push(`- Panel: ${report.seats.join(', ')}`);
  L.push(`- Duration: ${((report.finishedAt - report.startedAt) / 1000).toFixed(1)}s`);
  L.push('');

  L.push(
    '| Condition | Unanimous accuracy | Majority accuracy | Calls/question | Talked out of correct | Rescued | Unresolved |',
  );
  L.push('|---|---|---|---|---|---|---|');
  for (const r of report.results) {
    L.push(
      `| ${r.label} | ${(r.accuracy * 100).toFixed(1)}% (${r.correct}/${r.total}) | ` +
        `${(r.majorityAccuracy * 100).toFixed(1)}% | ` +
        `${r.callsPerQuestion.toFixed(1)} | ${r.talkedOutOfCorrect} | ${r.rescued} | ${r.unresolved} |`,
    );
  }
  L.push('');
  L.push(
    '_Unanimous accuracy counts only runs that actually converged; an unresolved run yields no answer by ' +
      'design. Majority accuracy asks a different question: did the largest camp hold the right claim?_',
    '',
  );

  L.push('## Verdict', '', report.verdict, '');

  const failures = report.perQuestion.filter((q) => Object.values(q.byCondition).some((c) => !c.correct));
  if (failures.length) {
    L.push('## Questions at least one condition got wrong', '');
    L.push('| Question | Expected | ' + Object.keys(report.perQuestion[0]?.byCondition ?? {}).join(' | ') + ' |');
    L.push('|---' .repeat(2 + Object.keys(report.perQuestion[0]?.byCondition ?? {}).length) + '|');
    for (const q of failures.slice(0, 40)) {
      const cells = Object.keys(report.perQuestion[0]?.byCondition ?? {}).map((c) => {
        const v = q.byCondition[c];
        return v ? `${v.correct ? '✓' : '✗'} ${v.answer.slice(0, 24)}` : '—';
      });
      L.push(`| ${q.question.slice(0, 60)} | ${q.expected} | ${cells.join(' | ')} |`);
    }
    L.push('');
  }

  return L.join('\n');
}
