import type { ConsensusReport } from '@consensus/shared';

import { compareKeys, normalizeKey } from './normalize.js';
import { campsFrom, type Judge, type JudgeContext, type JudgeInput } from './types.js';

/**
 * The default judge.
 *
 * Normalised exact match on `answer_key`, with numeric tolerance and unit
 * awareness. Nothing statistical, nothing learned, nothing that can be talked
 * into a wrong answer — the one component in this system that must not be a
 * language model.
 */
export class StructuredJudge implements Judge {
  readonly kind = 'structured' as const;
  readonly automatic = true;

  async compare(inputs: JudgeInput[], ctx: JudgeContext): Promise<ConsensusReport> {
    const tolerance = ctx.settings.numericTolerance;

    if (inputs.length === 0) {
      return { equivalent: false, judge: this.kind, camps: [], detail: 'no answers to compare' };
    }
    if (inputs.length === 1) {
      const only = inputs[0]!;
      return {
        equivalent: true,
        judge: this.kind,
        camps: campsFrom([only], (i) => normalizeKey(i.answerKey), (k) => k),
        detail: 'single surviving seat; nothing to compare',
      };
    }

    // Union-find over pairwise equivalence: numeric tolerance is not
    // transitive in general, so group by connectivity rather than by string.
    const parent = inputs.map((_, i) => i);
    const find = (i: number): number => {
      let root = i;
      while (parent[root] !== root) root = parent[root]!;
      let cur = i;
      while (parent[cur] !== cur) {
        const next = parent[cur]!;
        parent[cur] = root;
        cur = next;
      }
      return root;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };

    const differences: string[] = [];
    for (let i = 0; i < inputs.length; i++) {
      for (let j = i + 1; j < inputs.length; j++) {
        const cmp = compareKeys(inputs[i]!.answerKey, inputs[j]!.answerKey, { tolerance });
        if (cmp.equal) union(i, j);
        else if (cmp.detail) {
          differences.push(`${inputs[i]!.letter} vs ${inputs[j]!.letter}: ${cmp.detail}`);
        }
      }
    }

    const rootOf = new Map<string, string>();
    inputs.forEach((input, i) => rootOf.set(input.seatId, String(find(i))));

    const camps = campsFrom(
      inputs,
      (i) => rootOf.get(i.seatId) ?? i.seatId,
      (_key, members) => members[0]?.answerKey ?? '(no key)',
    );

    const derived = inputs.filter((i) => i.keyWasDerived).map((i) => i.letter);
    const notes: string[] = [];
    if (derived.length) {
      notes.push(
        `keys for ${derived.join(', ')} were derived from prose because the model did not declare one`,
      );
    }
    if (camps.length > 1) notes.push(differences.slice(0, 4).join('; '));

    return {
      equivalent: camps.length === 1,
      judge: this.kind,
      camps,
      detail: notes.filter(Boolean).join(' — ') || undefined,
    };
  }
}
