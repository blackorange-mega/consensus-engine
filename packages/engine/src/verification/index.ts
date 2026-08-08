import type { ConsensusReport, RunRecord, TransportFamily } from '@consensus/shared';

import { compareKeys, normalizeKey } from '../judges/normalize.js';
import { logger } from '../util/logger.js';

const log = logger('verify');

/**
 * Self-evaluation and cross-checking.
 *
 * Panel agreement on its own is a weak signal, and the app says so loudly
 * elsewhere. This module adds the checks that make agreement *mean* something:
 *
 *  1. **Self-consistency.** Ask one seat the same question several times at a
 *     non-zero temperature. A model that cannot reproduce its own answer should
 *     not carry the same weight as one that can — and this catches the case
 *     where a seat happened to guess the majority answer once.
 *
 *  2. **Cross-checking.** After convergence, ask a seat that was NOT in the
 *     winning camp to verify the agreed answer. A dissenter is a much harsher
 *     reviewer than a member of the majority, and if it now accepts the answer
 *     that is worth far more than another agreeing voice.
 *
 *  3. **Calibrated confidence.** Combine the signals that actually predict
 *     correctness into one number, with every contribution itemised so the user
 *     can see *why* — never a bare percentage they have to take on trust.
 *
 * The heterogeneity term deserves its own note. Zhang et al. (2025) find model
 * heterogeneity is the one reliable improvement to multi-agent debate, and that
 * homogeneous panels are exactly the configuration that underperforms. So four
 * seats agreeing is not four independent votes if they are four wrappers around
 * the same base model — this scores that explicitly rather than pretending
 * seat count is evidence.
 */

export interface VerificationConfig {
  selfConsistency: {
    enabled: boolean;
    /** Extra samples per seat, beyond the answer it already gave. */
    samples: number;
    /** Only spend the extra calls when the panel actually disagreed. */
    onlyWhenContested: boolean;
    /** Skip seats whose transport cannot vary temperature (UI-driven seats). */
    requireTemperature: boolean;
  };
  crossCheck: {
    enabled: boolean;
    /** Only cross-check when the panel converged; there is nothing to check otherwise. */
    onlyOnConvergence: boolean;
  };
}

export const DEFAULT_VERIFICATION: VerificationConfig = {
  selfConsistency: { enabled: false, samples: 2, onlyWhenContested: true, requireTemperature: true },
  crossCheck: { enabled: false, onlyOnConvergence: true },
};

export interface SeatReliability {
  seatId: string;
  /** Normalised keys the seat produced across its samples, including the original. */
  samples: string[];
  /** Fraction of samples matching the seat's own modal answer. */
  agreementRate: number;
  /** True when every sample made the same claim. */
  selfConsistent: boolean;
  /** The seat's own modal claim, which may differ from what it told the panel. */
  modalKey: string;
}

export interface CrossCheckResult {
  verifierSeatId: string;
  /** The verifier held a different position and was asked to review the winner. */
  wasDissenter: boolean;
  agrees: boolean;
  objection?: string;
}

export interface ConfidenceFactor {
  name: string;
  /** Signed contribution to the final score, in points. */
  contribution: number;
  detail: string;
}

export interface VerificationReport {
  perSeat: SeatReliability[];
  crossCheck?: CrossCheckResult;
  /** 0..1, itemised in `factors`. Never presented without them. */
  confidence: number;
  band: 'low' | 'moderate' | 'high';
  factors: ConfidenceFactor[];
  /** The single most useful sentence about how much to trust this run. */
  summary: string;
}

/* ------------------------------------------------------------ self-consistency */

export interface SelfConsistencyInput {
  seatId: string;
  /** The answer key the seat gave the panel. */
  declaredKey: string;
  /** Additional independently-sampled keys. */
  resampledKeys: string[];
  tolerance: number;
}

export function scoreSelfConsistency(input: SelfConsistencyInput): SeatReliability {
  const samples = [input.declaredKey, ...input.resampledKeys].map(normalizeKey).filter(Boolean);
  if (samples.length === 0) {
    return { seatId: input.seatId, samples: [], agreementRate: 0, selfConsistent: false, modalKey: '' };
  }

  // Cluster by tolerant comparison rather than string equality: "5" and "5.0"
  // are the same answer, and counting them apart would understate consistency.
  const clusters: Array<{ key: string; count: number }> = [];
  for (const sample of samples) {
    const hit = clusters.find((c) => compareKeys(c.key, sample, { tolerance: input.tolerance }).equal);
    if (hit) hit.count++;
    else clusters.push({ key: sample, count: 1 });
  }
  clusters.sort((a, b) => b.count - a.count);

  const modal = clusters[0]!;
  return {
    seatId: input.seatId,
    samples,
    agreementRate: modal.count / samples.length,
    selfConsistent: clusters.length === 1,
    modalKey: modal.key,
  };
}

/* ------------------------------------------------------------------ confidence */

export interface CalibrationInput {
  run: RunRecord;
  consensus: ConsensusReport | null;
  reliability: SeatReliability[];
  crossCheck?: CrossCheckResult;
  /** Transport family per seat, for the heterogeneity term. */
  familyOf: Record<string, TransportFamily>;
  /** Vendor per seat, derived from the seat id. */
  vendorOf: Record<string, string>;
}

/**
 * Combine the signals into one number.
 *
 * Deliberately conservative and deliberately transparent: the score starts from
 * a neutral prior and every term is shown. A high number here still does not
 * mean "correct" — it means "the panel agreed, independently, without folding,
 * and a dissenter checked it". That is the most this design can honestly claim.
 */
export function calibrateConfidence(input: CalibrationInput): VerificationReport {
  const { run, consensus, reliability, crossCheck } = input;
  const factors: ConfidenceFactor[] = [];

  const converged = run.outcome === 'converged';
  const contested = run.outcome === 'converged_contested';
  const alive = run.seatIds.filter((id) => run.seats[id]?.status !== 'dropped');
  const winning = consensus?.camps[0];

  // Start neutral. Nothing about a run is evidence until measured.
  let score = 0.5;

  /* --- agreement --------------------------------------------------------- */
  if (winning && alive.length > 0) {
    const share = winning.seatIds.length / alive.length;
    const delta = converged ? 0.18 * share : contested ? 0.06 * share : -0.15;
    score += delta;
    factors.push({
      name: 'panel agreement',
      contribution: delta,
      detail: `${winning.seatIds.length} of ${alive.length} surviving seats hold the winning claim`,
    });
  } else {
    score -= 0.2;
    factors.push({ name: 'panel agreement', contribution: -0.2, detail: 'the panel did not converge' });
  }

  /* --- heterogeneity ------------------------------------------------------ */
  if (winning) {
    const vendors = new Set(winning.seatIds.map((id) => input.vendorOf[id] ?? id));
    const families = new Set(winning.seatIds.map((id) => input.familyOf[id] ?? 'unknown'));
    const independent = Math.min(vendors.size, 4);
    const delta = independent >= 2 ? 0.04 * (independent - 1) : -0.1;
    score += delta;
    factors.push({
      name: 'panel heterogeneity',
      contribution: delta,
      detail:
        independent >= 2
          ? `${vendors.size} distinct vendors across ${families.size} transport families agree`
          : 'every agreeing seat comes from the same vendor — shared training data means shared errors, ' +
            'so this is closer to one vote than to several',
    });
  }

  /* --- self-consistency --------------------------------------------------- */
  if (reliability.length > 0) {
    const mean = reliability.reduce((n, r) => n + r.agreementRate, 0) / reliability.length;
    const delta = (mean - 0.75) * 0.24;
    score += delta;
    const shaky = reliability.filter((r) => !r.selfConsistent).map((r) => r.seatId);
    factors.push({
      name: 'self-consistency',
      contribution: delta,
      detail: shaky.length
        ? `${shaky.join(', ')} did not reproduce their own answer on resampling (mean ${(mean * 100).toFixed(0)}%)`
        : `every resampled seat reproduced its own answer (mean ${(mean * 100).toFixed(0)}%)`,
    });
  }

  /* --- capitulation ------------------------------------------------------- */
  const flips = alive.reduce((n, id) => n + (run.seats[id]?.flips ?? 0), 0);
  if (flips > 0) {
    const delta = -Math.min(0.15, flips * 0.04);
    score += delta;
    factors.push({
      name: 'position changes',
      contribution: delta,
      detail: `${flips} change(s) of position across the panel — agreement reached by folding is weaker than agreement reached independently`,
    });
  } else if (converged && run.stats.rounds === 1) {
    score += 0.08;
    factors.push({
      name: 'independent agreement',
      contribution: 0.08,
      detail: 'every seat gave the same answer in round 1, with no debate and no influence between them',
    });
  }

  /* --- cross-check -------------------------------------------------------- */
  if (crossCheck) {
    const delta = crossCheck.agrees ? (crossCheck.wasDissenter ? 0.12 : 0.05) : -0.22;
    score += delta;
    factors.push({
      name: 'cross-check',
      contribution: delta,
      detail: crossCheck.agrees
        ? `${crossCheck.verifierSeatId}${crossCheck.wasDissenter ? ', which had disagreed,' : ''} reviewed the agreed answer and accepted it`
        : `${crossCheck.verifierSeatId} reviewed the agreed answer and rejected it: ${crossCheck.objection ?? 'no reason given'}`,
    });
  }

  /* --- fidelity ----------------------------------------------------------- */
  const lossy = alive.filter((id) => run.seats[id]?.lossy);
  if (lossy.length) {
    score -= 0.05;
    factors.push({
      name: 'extraction fidelity',
      contribution: -0.05,
      detail: `${lossy.length} seat(s) returned text through a lossy path, so the compared text may not be exactly what the model produced`,
    });
  }
  if (consensus?.detail?.includes('derived from prose')) {
    score -= 0.05;
    factors.push({
      name: 'answer key quality',
      contribution: -0.05,
      detail: 'at least one comparison used a key inferred from prose rather than one the model declared',
    });
  }

  /* --- panel size --------------------------------------------------------- */
  if (alive.length < 3) {
    score -= 0.08;
    factors.push({
      name: 'panel size',
      contribution: -0.08,
      detail: `${alive.length} surviving seat(s) — too few to break a tie`,
    });
  }

  const confidence = Math.max(0.02, Math.min(0.97, score));
  const band = confidence >= 0.75 ? 'high' : confidence >= 0.5 ? 'moderate' : 'low';

  return {
    perSeat: reliability,
    crossCheck,
    confidence: Number(confidence.toFixed(3)),
    band,
    factors: factors.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
    summary: summarise(band, factors, run),
  };
}

function summarise(band: VerificationReport['band'], factors: ConfidenceFactor[], run: RunRecord): string {
  const worst = factors.filter((f) => f.contribution < 0).sort((a, b) => a.contribution - b.contribution)[0];
  const best = factors.filter((f) => f.contribution > 0).sort((a, b) => b.contribution - a.contribution)[0];

  if (run.outcome !== 'converged' && run.outcome !== 'converged_contested') {
    return 'The panel did not agree, so there is no answer to be confident about. Read the competing claims.';
  }

  const lead =
    band === 'high'
      ? 'Several independent checks point the same way.'
      : band === 'moderate'
        ? 'The panel agreed, but the supporting signals are mixed.'
        : 'Treat this answer with caution.';

  const because = best ? ` Strongest signal: ${best.detail}.` : '';
  const caveat = worst ? ` Weakest: ${worst.detail}.` : '';

  return `${lead}${because}${caveat} This measures how the panel behaved, not whether the answer is true.`;
}

/** Vendor guess from a seat id, for the heterogeneity term. */
export function vendorOf(seatId: string, adapter: string): string {
  const id = seatId.toLowerCase();
  for (const vendor of ['claude', 'anthropic', 'chatgpt', 'openai', 'gpt', 'gemini', 'google', 'grok', 'xai', 'deepseek', 'llama', 'qwen', 'mistral']) {
    if (id.includes(vendor)) {
      // Normalise the obvious aliases so one vendor is not counted twice.
      if (vendor === 'anthropic') return 'claude';
      if (vendor === 'chatgpt' || vendor === 'gpt') return 'openai';
      if (vendor === 'google') return 'gemini';
      if (vendor === 'xai') return 'grok';
      return vendor;
    }
  }
  log.debug(`could not infer a vendor for seat "${seatId}"; treating it as its own`);
  return `${adapter}:${seatId}`;
}
