import type { JudgeKind, TaskType } from '@consensus/shared';

import { logger } from '../util/logger.js';
import { LocalEmbeddingJudge } from './embedding.js';
import { HumanJudge, type EquivalenceAsker } from './human.js';
import { LlmJudge, type JudgeCaller } from './llm.js';
import { StructuredJudge } from './structured.js';
import type { Judge } from './types.js';

export * from './types.js';
export { StructuredJudge } from './structured.js';
export { LocalEmbeddingJudge } from './embedding.js';
export { LlmJudge } from './llm.js';
export { HumanJudge } from './human.js';
export * from './normalize.js';

const log = logger('judge');

export interface JudgeFactoryOptions {
  kind: JudgeKind;
  taskType: TaskType | null;
  /** Provided when an LLM judge seat is available. */
  llm?: { call: JudgeCaller; seatId: string };
  /** Provided when the UI can be asked. */
  ask?: EquivalenceAsker;
}

/**
 * Build the judge for a run.
 *
 * One rule is enforced here rather than left to configuration: the embedding
 * judge is never the sole arbiter of a factual or computational question.
 * Its `compare` already delegates the decision to the structured judge, and
 * this is the second belt — if a future edit loosened that class,
 * selection would still not hand it a factual question to arbitrate alone.
 */
export function createJudge(opts: JudgeFactoryOptions): Judge {
  switch (opts.kind) {
    case 'structured':
      return new StructuredJudge();

    case 'embedding': {
      const factualish = opts.taskType === 'factual' || opts.taskType === 'computational';
      if (factualish) {
        log.info(
          'embedding judge requested for a factual question; equivalence stays with the ' +
            'structured judge and embeddings contribute a prose-spread signal only',
        );
      }
      return new LocalEmbeddingJudge();
    }

    case 'llm': {
      if (!opts.llm) {
        log.warn('LLM judge requested but no judge seat is available; using the structured judge');
        return new StructuredJudge();
      }
      return new LlmJudge(opts.llm.call, opts.llm.seatId);
    }

    case 'human': {
      if (!opts.ask) {
        log.warn('human judge requested but no UI is attached; using the structured judge');
        return new StructuredJudge();
      }
      return new HumanJudge(opts.ask);
    }

    default:
      return new StructuredJudge();
  }
}
