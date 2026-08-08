import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_SETTINGS } from '@consensus/shared';

import { LocalEmbeddingJudge } from '../src/judges/embedding.js';
import { compareKeys, deriveKeyFromAnswer, normalizeKey, parseQuantity } from '../src/judges/normalize.js';
import { StructuredJudge } from '../src/judges/structured.js';
import type { JudgeContext, JudgeInput } from '../src/judges/types.js';

const opts = { tolerance: 1e-9 };

const ctx: JudgeContext = {
  runId: 'test',
  round: 1,
  prompt: 'q',
  taskType: 'factual',
  settings: DEFAULT_RUN_SETTINGS,
};

const input = (seatId: string, letter: string, answerKey: string, answer = answerKey): JudgeInput => ({
  seatId,
  letter,
  answer,
  answerKey,
  keyWasDerived: false,
});

describe('key normalisation', () => {
  it('strips filler and punctuation', () => {
    expect(normalizeKey('The answer is 42.')).toBe('42');
    expect(normalizeKey('  "Canberra"  ')).toBe('canberra');
    expect(normalizeKey('approximately 3.14')).toBe('3.14');
  });

  it('canonicalises yes/no', () => {
    expect(normalizeKey('Yes')).toBe('yes');
    expect(normalizeKey('nope')).toBe('no');
    expect(normalizeKey('True')).toBe('yes');
  });

  it('keeps negation, which is the whole ballgame', () => {
    expect(normalizeKey('It is not safe')).not.toBe(normalizeKey('It is safe'));
  });

  it('normalises digit separators', () => {
    expect(normalizeKey('1,000,000')).toBe('1000000');
  });
});

describe('quantities', () => {
  it('parses plain numbers and units', () => {
    expect(parseQuantity('42')?.value).toBe(42);
    expect(parseQuantity('200mg')?.family).toBe('mass');
    expect(parseQuantity('1/2')?.value).toBe(0.5);
  });

  it('converts within a unit family', () => {
    expect(compareKeys('1 kg', '1000 g', opts).equal).toBe(true);
    expect(compareKeys('2.5 l', '2500 ml', opts).equal).toBe(true);
    expect(compareKeys('1 hour', '60 min', opts).equal).toBe(true);
  });

  it('refuses to convert across families or currencies', () => {
    expect(compareKeys('5 kg', '5 m', opts).equal).toBe(false);
    expect(compareKeys('$5', '€5', opts).equal).toBe(false);
  });
});

/**
 * The measured failure mode of embedding similarity: on a small static
 * embedding model a direct negation scores 0.988 and a correct paraphrase
 * scores 0.246. These cases assert the structured judge gets every one of them
 * right, because it never looks at prose similarity at all.
 */
describe('the cases embedding similarity provably cannot judge', () => {
  const contradictions: Array<[string, string]> = [
    ['It is safe to combine these drugs.', 'It is not safe to combine these drugs.'],
    ['5', '6'],
    ['1919', '1918'],
    ['200 mg twice daily', '800 mg twice daily'],
    ['yes', 'no'],
  ];

  for (const [a, b] of contradictions) {
    it(`separates "${a}" from "${b}"`, () => {
      expect(compareKeys(a, b, opts).equal).toBe(false);
    });
  }

  it('accepts a genuine paraphrase of a number', () => {
    // The control row: the case an embedding threshold rejects.
    expect(compareKeys('The answer is 5.', '5', opts).equal).toBe(true);
  });
});

describe('structured judge', () => {
  it('finds a single camp when every key matches', async () => {
    const report = await new StructuredJudge().compare(
      [input('a', 'A', '42'), input('b', 'B', 'The answer is 42.'), input('c', 'C', '42')],
      ctx,
    );
    expect(report.equivalent).toBe(true);
    expect(report.camps).toHaveLength(1);
  });

  it('splits into camps and orders them by size', async () => {
    const report = await new StructuredJudge().compare(
      [input('a', 'A', '42'), input('b', 'B', '43'), input('c', 'C', '42')],
      ctx,
    );
    expect(report.equivalent).toBe(false);
    expect(report.camps).toHaveLength(2);
    expect(report.camps[0]?.seatIds).toEqual(['a', 'c']);
    expect(report.camps[1]?.seatIds).toEqual(['b']);
  });

  it('does not merge a missing key into a camp', async () => {
    const report = await new StructuredJudge().compare([input('a', 'A', '42'), input('b', 'B', '')], ctx);
    expect(report.equivalent).toBe(false);
  });

  it('notes when a key had to be derived from prose', async () => {
    const report = await new StructuredJudge().compare(
      [input('a', 'A', '42'), { ...input('b', 'B', '42'), keyWasDerived: true }],
      ctx,
    );
    expect(report.detail).toContain('derived from prose');
  });

  it('treats a single surviving seat as trivially equivalent', async () => {
    const report = await new StructuredJudge().compare([input('a', 'A', '42')], ctx);
    expect(report.equivalent).toBe(true);
    expect(report.detail).toContain('single surviving seat');
  });
});

describe('embedding judge is advisory only', () => {
  it('never overrides the structured decision on a contradiction', async () => {
    // Near-identical prose, opposite claims: the exact case where cosine
    // similarity is highest and most wrong.
    const report = await new LocalEmbeddingJudge().compare(
      [
        input('a', 'A', 'safe', 'It is safe to combine these drugs.'),
        input('b', 'B', 'not safe', 'It is not safe to combine these drugs.'),
      ],
      ctx,
    );
    expect(report.equivalent).toBe(false);
    expect(report.detail).toContain('advisory only');
  });

  it('reports prose spread when the panel agrees for different reasons', async () => {
    const report = await new LocalEmbeddingJudge().compare(
      [
        input('a', 'A', '42', 'Forty-two, by direct computation of the series.'),
        input('b', 'B', '42', 'The result is 42; I reached it via a completely different combinatorial argument.'),
      ],
      ctx,
    );
    expect(report.equivalent).toBe(true);
    expect(report.proseSpread).toBeGreaterThan(0);
  });
});

describe('derived keys', () => {
  it('takes the first meaningful line', () => {
    expect(deriveKeyFromAnswer('# Heading\n\nThe answer is 42.')).toBe('The answer is 42.');
  });

  it('ignores code blocks when deriving', () => {
    expect(deriveKeyFromAnswer('```js\nlet x = 1;\n```\nIt returns null.')).toBe('It returns null.');
  });
});
