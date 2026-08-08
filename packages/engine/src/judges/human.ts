import type { ConsensusReport } from '@consensus/shared';

import { StructuredJudge } from './structured.js';
import { campsFrom, type Judge, type JudgeContext, type JudgeInput } from './types.js';

/** How the engine asks the user to decide. Resolved by the UI over the run-control API. */
export type EquivalenceAsker = (
  inputs: JudgeInput[],
  ctx: JudgeContext,
  suggestion: ConsensusReport,
) => Promise<{ equivalent: boolean; note?: string }>;

/**
 * Human judge — the user clicks "same /
 * different" each round.
 *
 * The structured judge still runs first and its answer is shown as a
 * suggestion, so the user is deciding rather than starting from nothing. The
 * user's call always wins, and the report records that a human made it.
 */
export class HumanJudge implements Judge {
  readonly kind = 'human' as const;
  readonly automatic = false;

  private readonly suggest = new StructuredJudge();

  constructor(private readonly ask: EquivalenceAsker) {}

  async compare(inputs: JudgeInput[], ctx: JudgeContext): Promise<ConsensusReport> {
    const suggestion = await this.suggest.compare(inputs, ctx);
    if (inputs.length < 2) return { ...suggestion, judge: this.kind };

    const decision = await this.ask(inputs, ctx, suggestion);

    const camps = decision.equivalent
      ? campsFrom(inputs, () => 'user-agreed', (_k, m) => m[0]?.answerKey ?? 'agreed')
      : suggestion.camps;

    return {
      equivalent: decision.equivalent,
      judge: this.kind,
      camps,
      detail: [
        `decided by the user (structured judge suggested ${suggestion.equivalent ? 'equivalent' : 'different'})`,
        decision.note,
      ]
        .filter(Boolean)
        .join(' — '),
    };
  }
}
