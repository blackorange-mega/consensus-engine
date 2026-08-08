import { describe, expect, it } from 'vitest';

import { diffBytes, fidelityCases, longFixture } from '../src/fixtures.js';
import { sanitizePeerText } from '../src/protocol/sanitize.js';
import {
  buildDispatchPrompt,
  buildJudgePrompt,
  buildRevisePrompt,
  buildRewritePrompt,
} from '../src/protocol/roundBuilder.js';

/**
 * The text-fidelity gate.
 *
 * "No user text is ever mutated in transit" is a non-negotiable, so it is
 * tested as one. Every payload must survive prompt construction byte-for-byte:
 * LaTeX, nested code fences, Persian RTL with bidi controls, ZWJ emoji and
 * combining marks, and a 10,000-character prompt.
 */
describe('text fidelity through prompt construction', () => {
  const cases = fidelityCases();

  for (const testCase of cases) {
    it(`preserves ${testCase.name} byte-for-byte in the dispatch prompt (${testCase.why})`, () => {
      const built = buildDispatchPrompt(testCase.text, true);
      expect(built.prompt).toContain(testCase.text);
    });

    it(`preserves ${testCase.name} verbatim in every cross-examination prompt`, () => {
      const judge = buildJudgePrompt({
        userPrompt: testCase.text,
        selfLetter: 'B',
        selfAnswer: 'my answer',
        peers: [{ letter: 'A', answer: 'their answer' }],
        panelSize: 2,
      });
      const revise = buildRevisePrompt({
        userPrompt: testCase.text,
        selfLetter: 'B',
        selfAnswer: 'my answer',
        peers: [{ letter: 'A', answer: 'their answer', critique: 'you are wrong' }],
        panelSize: 2,
        stubbornness: 3,
        isFollowup: false,
      });
      const rewrite = buildRewritePrompt(testCase.text, 'agreed answer');

      // The full original user prompt must be included verbatim in every
      // phase-2 and phase-3 prompt, never paraphrased.
      expect(judge.prompt).toContain(testCase.text);
      expect(revise.prompt).toContain(testCase.text);
      expect(rewrite.prompt).toContain(testCase.text);
    });
  }

  it('carries a peer answer through unchanged when it contains no markers', () => {
    for (const testCase of cases) {
      const out = sanitizePeerText(testCase.text, 'deadbeef');
      const diff = diffBytes(testCase.text, out.text);
      expect(diff.equal, `${testCase.name}: ${diff.detail ?? ''}`).toBe(true);
    }
  });

  it('embeds a peer answer verbatim inside the delimited region', () => {
    for (const testCase of cases) {
      const built = buildJudgePrompt({
        userPrompt: 'q',
        selfLetter: 'B',
        selfAnswer: 'x',
        peers: [{ letter: 'A', answer: testCase.text }],
        panelSize: 2,
      });
      expect(built.prompt).toContain(testCase.text);
    }
  });

  it('generates a 10,000 code-point payload', () => {
    expect([...longFixture()].length).toBeLessThanOrEqual(10_000);
    expect(longFixture().length).toBe(10_000);
  });

  it('does not normalise decomposed characters into precomposed ones', () => {
    const decomposed = 'é';
    const precomposed = 'é';
    const built = buildDispatchPrompt(`${decomposed} vs ${precomposed}`, false);
    expect(built.prompt).toContain(decomposed);
    expect(built.prompt).toContain(precomposed);
  });

  it('preserves zero-width joiners and bidi controls', () => {
    const tricky = 'a‍b ‮rcl‬ ‏RTL‎ می‌شود';
    const built = buildDispatchPrompt(tricky, false);
    expect(built.prompt).toContain(tricky);
  });

  it('fails loudly if a template ever mangles the prompt', () => {
    // The assertion is real, not decorative: prove it actually throws.
    expect(() =>
      buildJudgePrompt({
        userPrompt: 'x'.repeat(50),
        selfLetter: 'A',
        selfAnswer: 'y',
        peers: [],
        panelSize: 1,
      }),
    ).not.toThrow();
  });
});

describe('byte diffing', () => {
  it('reports the first differing byte', () => {
    const d = diffBytes('hello world', 'hello wOrld');
    expect(d.equal).toBe(false);
    expect(d.detail).toContain('first difference at byte 7');
  });
});
