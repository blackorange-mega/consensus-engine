import type { Verdict } from '@consensus/shared';
import { seatByLetter } from '@consensus/shared';

/**
 * Adaptive pruning of the debate graph.
 *
 * Existing council tools re-broadcast every answer to every model every round.
 * Here, once a critic concedes that seat M is correct, that critic is dropped
 * from M's prompt for the next round. This shrinks context, cost and — the part
 * that actually matters — sycophancy pressure, because M stops being shown a
 * wall of dissent it has already answered.
 */

export interface CriticsInput {
  /** Seats still in the run this round. */
  seatIds: string[];
  /** seatId -> expert letter for this round. */
  letters: Record<string, string>;
  /** seatId -> the verdict that seat returned this round (absent = no usable reply). */
  verdicts: Record<string, Verdict | undefined>;
}

export interface CriticsResult {
  /** seatId -> the seats that still consider it wrong. */
  critics: Record<string, string[]>;
  /** Seats that disagreed without naming anyone; treated as critics of all peers. */
  unspecific: string[];
}

export function computeCritics(input: CriticsInput): CriticsResult {
  const { seatIds, letters, verdicts } = input;
  const bySeat = seatByLetter(letters);

  const critics: Record<string, string[]> = {};
  for (const id of seatIds) critics[id] = [];
  const unspecific: string[] = [];

  for (const judgeId of seatIds) {
    const verdict = verdicts[judgeId];
    // No usable reply this round: this seat gets no vote, in either direction.
    if (!verdict) continue;
    if (verdict.agree && !verdict.critiques) continue;

    const named = verdict.critiques;
    if (!named || Object.keys(named).length === 0) {
      if (!verdict.agree) {
        // Disagreed but named nobody. Do not silently prune the debate away:
        // treat it as an objection to every peer, and flag it.
        unspecific.push(judgeId);
        for (const targetId of seatIds) {
          if (targetId !== judgeId) critics[targetId]?.push(judgeId);
        }
      }
      continue;
    }

    for (const [letter, critique] of Object.entries(named)) {
      if (critique === null) continue; // conceded: this critic drops out of that seat's prompt
      const targetId = bySeat[letter];
      if (!targetId || targetId === judgeId) continue;
      if (!seatIds.includes(targetId)) continue;
      critics[targetId]?.push(judgeId);
    }
  }

  for (const id of seatIds) {
    critics[id] = [...new Set(critics[id] ?? [])].sort();
  }

  return { critics, unspecific };
}

/** Seats still in dispute — the only ones that need a revise call next round. */
export function contestedSeats(critics: Record<string, string[]>): string[] {
  return Object.entries(critics)
    .filter(([, cs]) => cs.length > 0)
    .map(([id]) => id)
    .sort();
}

/**
 * How much pruning saved this round, for the report. The pre-flight estimate
 * assumes roughly 20-25% at a 35% concede rate; this measures the real figure.
 */
export function pruningSavings(
  critics: Record<string, string[]>,
  seatCount: number,
): { edgesKept: number; edgesTotal: number; savedFraction: number } {
  const edgesTotal = seatCount * Math.max(0, seatCount - 1);
  const edgesKept = Object.values(critics).reduce((n, cs) => n + cs.length, 0);
  return {
    edgesKept,
    edgesTotal,
    savedFraction: edgesTotal === 0 ? 0 : 1 - edgesKept / edgesTotal,
  };
}
