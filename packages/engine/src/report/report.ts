import type { RunRecord, SeatTurn, VerificationReport } from '@consensus/shared';
import { STUBBORNNESS_LABELS } from '@consensus/shared';

import { normalizeKey } from '../judges/normalize.js';

/**
 * The run report, generated for every run and exportable as
 * Markdown and JSON.
 *
 * Its job is to answer the questions the divergence view exists for: who was
 * wrong initially, who corrected whom, who flipped and how often, who withdrew
 * and when — and to say plainly when the panel did not agree, because
 * "unresolved" is a first-class outcome and fabricating a consensus is the one
 * thing this app must never do.
 */

export interface ReportTimelineEntry {
  round: number;
  seatId: string;
  displayName: string;
  letter: string;
  kind: SeatTurn['kind'];
  verdict: 'agree' | 'disagree' | 'no reply' | '-';
  answerKey: string;
  answerHash: string;
  latencyMs: number;
  tokens?: { in?: number; out?: number };
  costUsd?: number;
  failure?: string;
  lossy?: boolean;
}

export interface RunReport {
  runId: string;
  title: string;
  prompt: string;
  createdAt: number;
  outcome: RunRecord['outcome'];
  taskType: string | null;
  settings: {
    mode: string;
    stubbornness: string;
    judge: string;
    maxRounds: number;
  };
  headline: string;
  finalAnswer: string | null;
  finalAnswerKey: string | null;
  timeline: ReportTimelineEntry[];
  seats: Array<{
    seatId: string;
    displayName: string;
    transport: string;
    firstAnswerKey: string | null;
    finalAnswerKey: string | null;
    changedItsMind: boolean;
    flips: number;
    agreedInRounds: number[];
    status: string;
    withdrewAtRound?: number;
    withdrawReason?: string;
    messagesUsed: number;
    lossy: boolean;
  }>;
  camps: Array<{ label: string; seats: string[]; answer: string }>;
  disagreement: string | null;
  confidence: {
    roundsToConvergence: number | null;
    unanimous: boolean;
    quorumAtEnd: number;
    panelStartedAt: number;
    proseSpread?: number;
    flipTotal: number;
  };
  cost: { calls: number; failedCalls: number; tokensIn: number; tokensOut: number; costUsd: number; wallMs: number };
  caveats: string[];
  /** Self-consistency, cross-check and calibrated confidence. */
  verification: VerificationReport | null;
}

const OUTCOME_HEADLINE: Record<string, (r: RunRecord) => string> = {
  converged: (r) =>
    `${r.rounds.at(-1)?.consensus?.camps[0]?.seatIds.length ?? 0}/${r.seatIds.length} models converged in ${r.stats.rounds} round(s)`,
  converged_contested: () => 'Converged, but contested — see the caveats below',
  unresolved: (r) => `Unresolved after ${r.stats.rounds} rounds — ${r.rounds.at(-1)?.consensus?.camps.length ?? 2} camps`,
  oscillating: () => 'Stopped: the panel was cycling between the same positions',
  quorum_lost: () => 'Stopped: fewer than two models were left in the panel',
  budget_exhausted: () => 'Stopped: the message budget was exhausted',
  timeout: () => 'Stopped: the run exceeded its time limit',
  aborted: () => 'Aborted by the user',
  no_debate: () => 'Answers shown side by side — this prompt has no single verifiable answer',
  error: () => 'The run failed',
};

export function buildReport(run: RunRecord, turns: SeatTurn[]): RunReport {
  const lettersByRound = new Map(run.rounds.map((r) => [r.round, r.letters]));

  const timeline: ReportTimelineEntry[] = turns
    .filter((t) => t.kind !== 'classify')
    .map((t) => ({
      round: t.round,
      seatId: t.seatId,
      displayName: run.seats[t.seatId]?.displayName ?? t.seatId,
      letter: lettersByRound.get(t.round)?.[t.seatId] ?? '-',
      kind: t.kind,
      verdict: t.failure ? 'no reply' : t.verdict ? (t.verdict.agree ? 'agree' : 'disagree') : '-',
      answerKey: t.answerKey ?? '',
      answerHash: t.answerHash ?? (t.answerKey ? normalizeKey(t.answerKey).slice(0, 24) : ''),
      latencyMs: t.latencyMs,
      tokens: t.tokens,
      costUsd: t.costUsd,
      failure: t.failure ? `${t.failure.reason}${t.failure.detail ? `: ${t.failure.detail}` : ''}` : undefined,
      lossy: t.lossy,
    }));

  const firstKeyBySeat = new Map<string, string>();
  for (const t of turns) {
    if (t.round === 1 && t.kind === 'dispatch' && t.answerKey && !firstKeyBySeat.has(t.seatId)) {
      firstKeyBySeat.set(t.seatId, t.answerKey);
    }
  }

  const consensus = run.rounds.at(-1)?.consensus ?? null;

  const seats = run.seatIds.map((id) => {
    const s = run.seats[id]!;
    const first = firstKeyBySeat.get(id) ?? null;
    return {
      seatId: id,
      displayName: s.displayName,
      transport: `${s.family}/${s.adapter}`,
      firstAnswerKey: first,
      finalAnswerKey: s.answerKey,
      changedItsMind: Boolean(first && s.answerKey && normalizeKey(first) !== normalizeKey(s.answerKey)),
      flips: s.flips,
      agreedInRounds: s.agreedRounds,
      status: s.status,
      withdrewAtRound: s.droppedAtRound,
      withdrawReason: s.dropReason,
      messagesUsed: s.messagesUsed,
      lossy: Boolean(s.lossy),
    };
  });

  const camps = (consensus?.camps ?? []).map((c) => ({
    label: c.label,
    seats: c.seatIds.map((id) => run.seats[id]?.displayName ?? id),
    answer: c.representativeAnswer,
  }));

  const roundsToConvergence =
    run.outcome === 'converged' || run.outcome === 'converged_contested' ? run.stats.rounds : null;

  const caveats = buildCaveats(run, seats, consensus);

  return {
    runId: run.id,
    title: run.title,
    prompt: run.prompt,
    createdAt: run.createdAt,
    outcome: run.outcome,
    taskType: run.classification?.type ?? null,
    settings: {
      mode: run.settings.mode,
      stubbornness: `${run.settings.stubbornness} — ${STUBBORNNESS_LABELS[run.settings.stubbornness]}`,
      judge: run.settings.judge,
      maxRounds: run.settings.maxRounds,
    },
    headline: (OUTCOME_HEADLINE[run.outcome ?? 'error'] ?? (() => 'Run finished'))(run),
    finalAnswer: run.finalAnswer,
    finalAnswerKey: run.finalAnswerKey,
    timeline,
    seats,
    camps,
    disagreement: camps.length > 1 ? describeDisagreement(camps) : null,
    confidence: {
      roundsToConvergence,
      unanimous: run.outcome === 'converged' && (consensus?.camps[0]?.seatIds.length ?? 0) === run.seatIds.length,
      quorumAtEnd: run.seatIds.filter((id) => run.seats[id]?.status !== 'dropped').length,
      panelStartedAt: run.seatIds.length,
      proseSpread: consensus?.proseSpread,
      flipTotal: seats.reduce((n, s) => n + s.flips, 0),
    },
    cost: {
      calls: run.stats.calls,
      failedCalls: run.stats.failedCalls,
      tokensIn: run.stats.tokensIn,
      tokensOut: run.stats.tokensOut,
      costUsd: run.stats.costUsd,
      wallMs: run.stats.wallMs,
    },
    caveats,
    verification: run.verification,
  };
}

function describeDisagreement(camps: RunReport['camps']): string {
  const [a, b, ...rest] = camps;
  if (!a || !b) return '';
  const extra = rest.length ? `, and ${rest.length} further position(s)` : '';
  return (
    `${a.seats.join(', ')} hold "${a.label}"; ` +
    `${b.seats.join(', ')} hold "${b.label}"${extra}. ` +
    `The substantive difference is the claim itself, not the wording.`
  );
}

function buildCaveats(
  run: RunRecord,
  seats: RunReport['seats'],
  consensus: RunRecord['rounds'][number]['consensus'],
): string[] {
  const caveats: string[] = [];

  if (run.outcome === 'converged' || run.outcome === 'converged_contested') {
    caveats.push(
      'Convergence is not correctness. Models trained on overlapping data share errors, ' +
        'so a panel can be confidently and identically wrong.',
    );
  }

  if (run.outcome === 'unresolved' || run.outcome === 'oscillating') {
    const largest = consensus?.camps[0];
    caveats.push(
      'No answer was returned because the panel did not agree. That is deliberate — a 3-1 split is not a ' +
        'consensus and this app will not present one as if it were. Read the competing claims below and decide.',
    );
    if (largest && (consensus?.camps.length ?? 0) > 1) {
      caveats.push(
        `For what it is worth, the largest camp (${largest.seatIds.length} of ${run.seatIds.length}) holds ` +
          `"${largest.label}". That is an observed count, not a verdict.`,
      );
    }
  }

  if (run.outcome === 'oscillating') {
    caveats.push(
      'The panel returned to a position it had already held, so further rounds would not have helped. ' +
        'This usually means one seat never concedes; lower the stubbornness setting or replace that seat.',
    );
  }

  if (run.outcome === 'quorum_lost') {
    caveats.push(
      'The panel shrank below two models, so there was nothing left to cross-examine. The answers shown are ' +
        'the last ones each model gave before it withdrew.',
    );
  }

  if (run.outcome === 'converged_contested') {
    caveats.push(
      consensus?.equivalent
        ? 'The answers match, but at least one model still registered an objection — read the timeline before relying on this.'
        : 'Every model voted to agree, but their stated answers are not the same claim. The agreement is nominal, not substantive.',
    );
  }

  const capitulators = seats.filter((s) => s.flips >= 2);
  if (capitulators.length) {
    caveats.push(
      `${capitulators.map((s) => s.displayName).join(', ')} changed position more than once. ` +
        'A model that flips every round is not converging, it is capitulating.',
    );
  }

  const talkedOut = seats.filter(
    (s) =>
      s.firstAnswerKey &&
      run.finalAnswerKey &&
      normalizeKey(s.firstAnswerKey) === normalizeKey(run.finalAnswerKey) &&
      s.finalAnswerKey &&
      normalizeKey(s.finalAnswerKey) !== normalizeKey(run.finalAnswerKey),
  );
  if (talkedOut.length) {
    caveats.push(
      `${talkedOut.map((s) => s.displayName).join(', ')} gave the agreed answer in round 1 and was then ` +
        'talked out of it. Consider raising the stubbornness setting.',
    );
  }

  const withdrawn = seats.filter((s) => s.status === 'dropped');
  if (withdrawn.length) {
    caveats.push(
      `${withdrawn.map((s) => `${s.displayName} (round ${s.withdrewAtRound}, ${s.withdrawReason})`).join('; ')} ` +
        'left the panel mid-run. Their last answers are shown but they did not take part in later rounds.',
    );
  }

  const lossy = seats.filter((s) => s.lossy);
  if (lossy.length) {
    caveats.push(
      `${lossy.map((s) => s.displayName).join(', ')} returned text through a lossy extraction path, so ` +
        'formatting (LaTeX, code blocks) may not be byte-exact.',
    );
  }

  const derived = consensus?.detail?.includes('derived from prose');
  if (derived) {
    caveats.push('At least one comparison used a key derived from prose rather than one the model declared.');
  }

  if (run.seatIds.length < 3) {
    caveats.push('A two-seat panel cannot break a tie; it can only tell you that two models disagree.');
  }

  return caveats;
}

/* ------------------------------------------------------------------ export */

export function reportToMarkdown(report: RunReport): string {
  const L: string[] = [];
  const dt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

  L.push(`# ${report.title}`, '');
  L.push(`**${report.headline}**`, '');
  L.push(`- Run: \`${report.runId}\``);
  L.push(`- Started: ${dt(report.createdAt)}`);
  L.push(`- Outcome: \`${report.outcome}\``);
  L.push(`- Task type: ${report.taskType ?? 'unclassified'}`);
  L.push(`- Mode: ${report.settings.mode} · Judge: ${report.settings.judge} · Max rounds: ${report.settings.maxRounds}`);
  L.push(`- Agreement modulation: ${report.settings.stubbornness}`);
  L.push('');

  L.push('## Question', '', '```text', report.prompt, '```', '');

  if (report.finalAnswer) {
    L.push('## Answer', '', report.finalAnswer, '');
    if (report.finalAnswerKey) L.push(`_Bare claim: \`${report.finalAnswerKey}\`_`, '');
  }

  if (report.disagreement) {
    L.push('## Unresolved disagreement', '', report.disagreement, '');
    for (const camp of report.camps) {
      L.push(`### ${camp.label} — ${camp.seats.join(', ')}`, '', camp.answer, '');
    }
  }

  L.push('## Panel', '');
  L.push('| Model | Transport | Round 1 | Final | Flips | Agreed in | Status | Msgs |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const s of report.seats) {
    L.push(
      `| ${s.displayName} | ${s.transport} | ${s.firstAnswerKey ?? '—'} | ${s.finalAnswerKey ?? '—'} | ` +
        `${s.flips} | ${s.agreedInRounds.join(', ') || '—'} | ${s.status}${s.withdrewAtRound ? ` @${s.withdrewAtRound}` : ''} | ${s.messagesUsed} |`,
    );
  }
  L.push('');

  L.push('## Timeline', '');
  L.push('| Round | Model | Expert | Step | Verdict | Key | Latency |');
  L.push('|---|---|---|---|---|---|---|');
  for (const t of report.timeline) {
    L.push(
      `| ${t.round} | ${t.displayName} | ${t.letter} | ${t.kind} | ${t.failure ? `**${t.failure}**` : t.verdict} | ` +
        `${t.answerKey.slice(0, 40) || '—'} | ${(t.latencyMs / 1000).toFixed(1)}s |`,
    );
  }
  L.push('');

  L.push('## Confidence signals', '');
  L.push(`- Rounds to convergence: ${report.confidence.roundsToConvergence ?? 'did not converge'}`);
  L.push(`- Unanimous: ${report.confidence.unanimous ? 'yes' : 'no'}`);
  L.push(`- Panel size: ${report.confidence.panelStartedAt} at start, ${report.confidence.quorumAtEnd} at end`);
  L.push(`- Total position changes across the panel: ${report.confidence.flipTotal}`);
  if (report.confidence.proseSpread !== undefined) {
    L.push(`- Prose spread (advisory only): ${report.confidence.proseSpread}`);
  }
  L.push('');

  L.push('## Cost', '');
  L.push(
    `- ${report.cost.calls} call(s), ${report.cost.failedCalls} failed, ` +
      `${(report.cost.wallMs / 1000).toFixed(1)}s wall clock`,
  );
  L.push(`- Tokens: ${report.cost.tokensIn} in, ${report.cost.tokensOut} out`);
  if (report.cost.costUsd > 0) L.push(`- Estimated cost: $${report.cost.costUsd.toFixed(4)}`);
  L.push('');

  if (report.verification) {
    const v = report.verification;
    L.push('## Verification', '');
    L.push(`**Confidence: ${(v.confidence * 100).toFixed(0)}% (${v.band})**`, '');
    L.push(v.summary, '');
    L.push('| Factor | Effect | Detail |');
    L.push('|---|---|---|');
    for (const f of v.factors) {
      const sign = f.contribution >= 0 ? '+' : '';
      L.push(`| ${f.name} | ${sign}${(f.contribution * 100).toFixed(1)} | ${f.detail} |`);
    }
    L.push('');
    if (v.perSeat.length) {
      L.push('Self-consistency on resampling:', '');
      for (const s2 of v.perSeat) {
        L.push(
          `- ${s2.seatId}: ${(s2.agreementRate * 100).toFixed(0)}% ` +
            `(${s2.selfConsistent ? 'consistent' : 'INCONSISTENT with itself'})`,
        );
      }
      L.push('');
    }
  }

  if (report.caveats.length) {
    L.push('## Read this before acting on the answer', '');
    for (const c of report.caveats) L.push(`- ${c}`);
    L.push('');
  }

  return L.join('\n');
}
