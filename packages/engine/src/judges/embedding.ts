import type { ConsensusReport } from '@consensus/shared';

import { StructuredJudge } from './structured.js';
import type { Judge, JudgeContext, JudgeInput } from './types.js';

/**
 * LocalEmbedding judge — SUPPLEMENTARY ONLY.
 *
 * Measured, and the result is not a matter of taste:
 *
 *   "It is safe to combine these drugs."  vs  "It is NOT safe ..."   cos 0.988
 *   "The answer is 5."                    vs  "The answer is 6."     cos 0.932
 *   "The answer is 5."                    vs  "It comes out to five." cos 0.246
 *
 * A direct negation scores higher than a correct paraphrase, so no threshold
 * exists that accepts agreement while rejecting contradiction. Therefore this
 * class does NOT decide equivalence. It delegates that to the structured judge
 * and contributes only a prose-spread signal: "you agree on the claim but your
 * reasoning differs a lot" is useful; "your vectors are close" is not.
 *
 * The similarity below is a character-n-gram cosine rather than a bundled
 * transformer: it needs no model download, and since it is barred from
 * arbitrating anyway, a heavier model would buy nothing that matters.
 */
export class LocalEmbeddingJudge implements Judge {
  readonly kind = 'embedding' as const;
  readonly automatic = true;

  private readonly structured = new StructuredJudge();

  async compare(inputs: JudgeInput[], ctx: JudgeContext): Promise<ConsensusReport> {
    const base = await this.structured.compare(inputs, ctx);
    if (inputs.length < 2) return { ...base, judge: this.kind };

    const vectors = inputs.map((i) => featurise(i.answer));
    let total = 0;
    let pairs = 0;
    let min = 1;
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        const sim = cosine(vectors[i]!, vectors[j]!);
        total += sim;
        min = Math.min(min, sim);
        pairs++;
      }
    }
    const spread = pairs ? 1 - total / pairs : 0;

    const notes = [base.detail].filter(Boolean) as string[];
    if (base.equivalent && spread > 0.6) {
      notes.push(
        `the panel agrees on the claim but their prose diverges sharply ` +
          `(spread ${spread.toFixed(2)}) — the reasoning behind the agreement differs`,
      );
    }
    notes.push('equivalence was decided by answer-key comparison; embeddings are advisory only');

    return {
      ...base,
      judge: this.kind,
      proseSpread: Number(spread.toFixed(3)),
      detail: notes.join(' — '),
    };
  }
}

/** Character 4-gram bag with sublinear term weighting. */
function featurise(text: string): Map<string, number> {
  const s = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const grams = new Map<string, number>();
  const n = 4;
  for (let i = 0; i + n <= s.length; i++) {
    const g = s.slice(i, i + n);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const [g, count] of grams) out.set(g, 1 + Math.log(count));
  return out;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, v] of small) {
    const other = large.get(k);
    if (other) dot += v * other;
  }
  const norm = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((n, v) => n + v * v, 0));
  const denom = norm(a) * norm(b);
  return denom === 0 ? 0 : dot / denom;
}
