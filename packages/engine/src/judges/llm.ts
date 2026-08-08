import type { ConsensusReport } from '@consensus/shared';

import { templates } from '../prompts/loader.js';
import { nonce as makeNonce } from '../util/hash.js';
import { logger } from '../util/logger.js';
import { delimit, sanitizePeerText } from '../protocol/sanitize.js';
import { StructuredJudge } from './structured.js';
import { campsFrom, type Judge, type JudgeContext, type JudgeInput } from './types.js';

const log = logger('judge:llm');

/** Anything that can turn a prompt into text: a CLI seat, a local model, an API. */
export type JudgeCaller = (prompt: string, opts: { timeoutMs: number }) => Promise<string>;

/**
 * LlmJudge.
 *
 * With this installed the marker protocol can be switched off entirely and the
 * judge reads plain prose. It is the only judge that can handle answers with no
 * clean answer_key — at the cost of one extra model call per round and of being
 * itself fallible.
 *
 * Two safeguards:
 *  - the judge model should not be one of the debating seats (checked by the
 *    caller, which prefers a local/unmetered model);
 *  - if the judge fails or replies unusably, we fall back to the structured
 *    judge rather than guessing, and say so in the report.
 */
export class LlmJudge implements Judge {
  readonly kind = 'llm' as const;
  readonly automatic = true;

  private readonly fallback = new StructuredJudge();

  constructor(
    private readonly call: JudgeCaller,
    private readonly judgeSeatId: string,
  ) {}

  async compare(inputs: JudgeInput[], ctx: JudgeContext): Promise<ConsensusReport> {
    if (inputs.length < 2) return { ...(await this.fallback.compare(inputs, ctx)), judge: this.kind };

    const n = makeNonce();
    const answers = inputs
      .map((i) => {
        const clean = sanitizePeerText(i.answer, n);
        return delimit(`EXPERT_${i.letter}`, clean.text, n);
      })
      .join('\n\n');

    const prompt = templates.render('llm_judge', {
      original_prompt: ctx.prompt,
      answers,
      nonce: n,
    });

    let raw: string;
    try {
      raw = await this.call(prompt, { timeoutMs: ctx.settings.callTimeoutMs });
    } catch (err) {
      log.warn('judge model failed; falling back to structured comparison', String(err));
      const base = await this.fallback.compare(inputs, ctx);
      return { ...base, detail: `LLM judge unavailable (${String(err)}); ${base.detail ?? ''}`.trim() };
    }

    const parsed = parseJudgeReply(raw);
    if (!parsed) {
      log.warn('judge model reply was unusable; falling back to structured comparison');
      const base = await this.fallback.compare(inputs, ctx);
      return { ...base, detail: `LLM judge reply was unusable; ${base.detail ?? ''}`.trim() };
    }

    const byLetter = new Map(inputs.map((i) => [i.letter, i]));
    const assigned = new Set<string>();
    const camps: ConsensusReport['camps'] = [];

    for (const camp of parsed.camps) {
      const members = camp.experts.map((l) => byLetter.get(l)).filter((x): x is JudgeInput => Boolean(x));
      for (const m of members) assigned.add(m.letter);
      if (!members.length) continue;
      camps.push({
        key: camp.label || members.map((m) => m.letter).join('+'),
        label: camp.label || members[0]!.answerKey,
        seatIds: members.map((m) => m.seatId).sort(),
        representativeAnswer: members[0]!.answer,
      });
    }

    // Any expert the judge forgot is its own camp: never silently merged into
    // a consensus it was not placed in.
    const orphans = inputs.filter((i) => !assigned.has(i.letter));
    if (orphans.length) {
      camps.push(...campsFrom(orphans, (i) => i.letter, (_k, m) => m[0]?.answerKey ?? '(unplaced)'));
      log.warn(`judge omitted ${orphans.map((o) => o.letter).join(', ')}; kept them as separate camps`);
    }

    const equivalent = camps.length === 1 && parsed.equivalent;

    return {
      equivalent,
      judge: this.kind,
      camps,
      detail: [
        `judged by ${this.judgeSeatId}`,
        parsed.difference ?? undefined,
        orphans.length ? `${orphans.length} expert(s) were not placed by the judge` : undefined,
      ]
        .filter(Boolean)
        .join(' — '),
    };
  }
}

interface JudgeReply {
  equivalent: boolean;
  camps: Array<{ label: string; experts: string[] }>;
  difference: string | null;
}

export function parseJudgeReply(raw: string): JudgeReply | null {
  const fence = raw.match(/```[ \t]*verdict[ \t]*\r?\n([\s\S]*?)```/i);
  const body = fence?.[1] ?? raw;
  const obj = body.match(/\{[\s\S]*\}/);
  if (!obj) return null;
  try {
    const parsed = JSON.parse(obj[0].replace(/,\s*([}\]])/g, '$1')) as Record<string, unknown>;
    if (typeof parsed.equivalent !== 'boolean') return null;
    const rawCamps = Array.isArray(parsed.camps) ? parsed.camps : [];
    const camps = rawCamps
      .map((c) => {
        const camp = c as Record<string, unknown>;
        const experts = Array.isArray(camp.experts)
          ? camp.experts.map((e) => String(e).trim().toUpperCase().replace(/^EXPERT[\s_-]*/, ''))
          : [];
        return { label: typeof camp.label === 'string' ? camp.label : '', experts };
      })
      .filter((c) => c.experts.length > 0);
    return {
      equivalent: parsed.equivalent,
      camps,
      difference: typeof parsed.difference === 'string' ? parsed.difference : null,
    };
  } catch {
    return null;
  }
}
