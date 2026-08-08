import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ENGINE_ROOT } from '../config.js';

/**
 * The golden set for the evaluation harness.
 *
 * Every item must have an answer that is checkable without judgement, because
 * the harness compares answer keys mechanically. The shipped set is deliberately
 * weighted towards items whose correctness is true *by construction* —
 * arithmetic, unit conversion, logic — rather than trivia, so the baseline
 * cannot be wrong about its own ground truth.
 *
 * Add your own at `packages/engine/eval/goldens.jsonl`, one JSON object per
 * line. Use 100-200 items before drawing any conclusions; the built-in set is a
 * smoke test, not a benchmark.
 */

export interface Golden {
  id: string;
  question: string;
  /** The canonical bare claim, compared with the structured judge. */
  key: string;
  type: 'computational' | 'factual' | 'code' | 'logic';
  /** Items designed to split a panel: a plausible wrong answer is easy to reach. */
  adversarial?: boolean;
}

const BUILT_IN: Golden[] = [
  // --- arithmetic and algebra: correct by construction ---------------------
  { id: 'ar-1', question: 'What is 17 * 24? Reply with only the number.', key: '408', type: 'computational' },
  { id: 'ar-2', question: 'What is 1024 / 16? Reply with only the number.', key: '64', type: 'computational' },
  { id: 'ar-3', question: 'What is 2^10 - 3^4? Reply with only the number.', key: '943', type: 'computational' },
  { id: 'ar-4', question: 'What is the sum of the integers from 1 to 100 inclusive?', key: '5050', type: 'computational' },
  { id: 'ar-5', question: 'What is 15% of 240? Reply with only the number.', key: '36', type: 'computational' },
  { id: 'ar-6', question: 'Solve for x: 3x + 7 = 28. Reply with only the value of x.', key: '7', type: 'computational' },
  { id: 'ar-7', question: 'What is the greatest common divisor of 48 and 180?', key: '12', type: 'computational' },
  { id: 'ar-8', question: 'What is 0.1 + 0.2 exactly, as a decimal number?', key: '0.3', type: 'computational', adversarial: true },
  { id: 'ar-9', question: 'How many seconds are there in 2.5 hours?', key: '9000', type: 'computational' },
  { id: 'ar-10', question: 'What is the 12th Fibonacci number, counting F(1)=1, F(2)=1?', key: '144', type: 'computational' },

  // --- classic reasoning traps: where a lone model most often fails ---------
  {
    id: 'lg-1',
    question:
      'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost, in dollars?',
    key: '0.05',
    type: 'logic',
    adversarial: true,
  },
  {
    id: 'lg-2',
    question:
      'If it takes 5 machines 5 minutes to make 5 widgets, how long would it take 100 machines to make 100 widgets, in minutes?',
    key: '5',
    type: 'logic',
    adversarial: true,
  },
  {
    id: 'lg-3',
    question:
      'A lily pad patch doubles in size every day and covers the whole lake on day 48. On which day did it cover half the lake?',
    key: '47',
    type: 'logic',
    adversarial: true,
  },
  {
    id: 'lg-4',
    question: 'How many times does the letter "r" appear in the word "strawberry"?',
    key: '3',
    type: 'logic',
    adversarial: true,
  },
  {
    id: 'lg-5',
    question: 'Which is larger, 9.11 or 9.9? Reply with only the larger number.',
    key: '9.9',
    type: 'logic',
    adversarial: true,
  },
  {
    id: 'lg-6',
    question:
      'I have 3 apples today. Yesterday I ate 2 apples. How many apples do I have now? Reply with only the number.',
    key: '3',
    type: 'logic',
    adversarial: true,
  },
  {
    id: 'lg-7',
    question:
      'Sally has 3 brothers. Each brother has 2 sisters. How many sisters does Sally have? Reply with only the number.',
    key: '1',
    type: 'logic',
    adversarial: true,
  },

  // --- units and conversion: substitution errors are the failure mode -------
  { id: 'un-1', question: 'How many millilitres are in 2.5 litres?', key: '2500 ml', type: 'computational' },
  { id: 'un-2', question: 'How many minutes are in one week?', key: '10080', type: 'computational' },
  { id: 'un-3', question: 'Convert 1.5 kilograms to grams.', key: '1500 g', type: 'computational' },
  { id: 'un-4', question: 'How many bytes are in 4 kibibytes (KiB)?', key: '4096', type: 'computational', adversarial: true },

  // --- yes/no polarity: the case embeddings provably cannot judge -----------
  { id: 'yn-1', question: 'Is 91 a prime number? Answer yes or no.', key: 'no', type: 'computational', adversarial: true },
  { id: 'yn-2', question: 'Is 2 the only even prime number? Answer yes or no.', key: 'yes', type: 'computational' },
  { id: 'yn-3', question: 'Is 0.999... (repeating) exactly equal to 1? Answer yes or no.', key: 'yes', type: 'computational', adversarial: true },
  { id: 'yn-4', question: 'Is every square a rectangle? Answer yes or no.', key: 'yes', type: 'logic' },
  { id: 'yn-5', question: 'Is every rectangle a square? Answer yes or no.', key: 'no', type: 'logic' },

  // --- a few very safe facts ----------------------------------------------
  { id: 'fa-1', question: 'What is the capital city of Australia?', key: 'canberra', type: 'factual', adversarial: true },
  { id: 'fa-2', question: 'How many sides does a hexagon have?', key: '6', type: 'factual' },
  { id: 'fa-3', question: 'What is the chemical symbol for gold?', key: 'au', type: 'factual' },
  { id: 'fa-4', question: 'How many bits are in one byte?', key: '8', type: 'factual' },
  { id: 'fa-5', question: 'What is the boiling point of water at sea level in degrees Celsius?', key: '100', type: 'factual' },

  // --- code: testable outcomes --------------------------------------------
  {
    id: 'cd-1',
    question:
      'In Python, what does `len([1, 2, 3][1:])` evaluate to? Reply with only the number.',
    key: '2',
    type: 'code',
  },
  {
    id: 'cd-2',
    question: 'In JavaScript, what does `typeof null` return? Reply with only the string it returns.',
    key: 'object',
    type: 'code',
    adversarial: true,
  },
  {
    id: 'cd-3',
    question: 'In Python, what is the value of `3 // 2`? Reply with only the number.',
    key: '1',
    type: 'code',
  },
  {
    id: 'cd-4',
    question: 'In JavaScript, what does `[] + []` evaluate to? Reply with only the resulting value.',
    key: '',
    type: 'code',
    adversarial: true,
  },
];

/**
 * Items whose answers are computed here rather than typed in.
 *
 * Drawing conclusions needs 100-200 questions, and a hand-written set that
 * large is a liability: every entry is a chance to
 * enshrine a wrong answer, and a benchmark that is wrong about its own ground
 * truth is worse than no benchmark. Generating the arithmetic means the
 * expected answer is correct by construction.
 *
 * Deterministic — the same set every run, so results stay comparable.
 */
function generated(): Golden[] {
  const out: Golden[] = [];
  const push = (id: string, question: string, key: string | number, type: Golden['type'] = 'computational') =>
    out.push({ id, question, key: String(key), type });

  // Multiplication with awkward carries.
  const products: Array<[number, number]> = [
    [23, 47], [64, 39], [128, 17], [91, 88], [37, 53],
    [116, 24], [72, 65], [19, 143], [58, 76], [204, 33],
  ];
  products.forEach(([a, b], i) =>
    push(`gen-mul-${i}`, `What is ${a} * ${b}? Reply with only the number.`, a * b),
  );

  // Percentages that do not come out round.
  const percents: Array<[number, number]> = [
    [12, 375], [35, 240], [7, 850], [65, 120], [18, 1450], [92, 275],
  ];
  percents.forEach(([p, n], i) =>
    push(`gen-pct-${i}`, `What is ${p}% of ${n}? Reply with only the number.`, (p / 100) * n),
  );

  // Greatest common divisor.
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const pairs: Array<[number, number]> = [
    [462, 1071], [270, 192], [1071, 462], [84, 132], [surd(3), surd(5)],
  ];
  pairs.forEach(([a, b], i) => push(`gen-gcd-${i}`, `What is the greatest common divisor of ${a} and ${b}?`, gcd(a, b)));

  // Sum of an inclusive integer range.
  const ranges: Array<[number, number]> = [
    [1, 50], [10, 60], [7, 77], [100, 200],
  ];
  ranges.forEach(([a, b], i) =>
    push(
      `gen-sum-${i}`,
      `What is the sum of all integers from ${a} to ${b} inclusive?`,
      ((a + b) * (b - a + 1)) / 2,
    ),
  );

  // Powers and roots.
  const powers: Array<[number, number]> = [
    [2, 12], [3, 7], [5, 5], [7, 4], [12, 3],
  ];
  powers.forEach(([b, e], i) => push(`gen-pow-${i}`, `What is ${b}^${e}? Reply with only the number.`, b ** e));

  // Modular arithmetic — a common silent-failure case for models.
  const mods: Array<[number, number]> = [
    [1234, 7], [98765, 11], [4321, 13], [55555, 9],
  ];
  mods.forEach(([a, m], i) =>
    push(`gen-mod-${i}`, `What is ${a} mod ${m}? Reply with only the number.`, a % m),
  );

  // Unit conversion, where the failure mode is substitution rather than arithmetic.
  const conversions: Array<[string, string, number, string]> = [
    ['3.5 kilograms', 'grams', 3500, 'g'],
    ['1.25 litres', 'millilitres', 1250, 'ml'],
    ['4 hours', 'seconds', 14400, ''],
    ['2.5 kilometres', 'metres', 2500, 'm'],
    ['750 milligrams', 'grams', 0.75, 'g'],
    ['3 days', 'hours', 72, ''],
  ];
  conversions.forEach(([from, to, value, unit], i) =>
    push(`gen-conv-${i}`, `Convert ${from} to ${to}. Reply with only the value.`, `${value}${unit ? ` ${unit}` : ''}`),
  );

  // Primality — a yes/no where embeddings provably cannot help.
  const primalities: Array<[number, boolean]> = [
    [97, true], [91, false], [143, false], [211, true], [289, false], [307, true],
  ];
  primalities.forEach(([n, isPrime], i) =>
    push(`gen-prime-${i}`, `Is ${n} a prime number? Answer yes or no.`, isPrime ? 'yes' : 'no', 'computational'),
  );

  // Digit counting inside a word — the "strawberry" class of failure.
  const counts: Array<[string, string]> = [
    ['mississippi', 's'], ['bookkeeper', 'e'], ['strawberry', 'r'], ['possession', 's'], ['accommodate', 'm'],
  ];
  counts.forEach(([word, letter], i) =>
    push(
      `gen-count-${i}`,
      `How many times does the letter "${letter}" appear in "${word}"? Reply with only the number.`,
      word.split('').filter((c) => c === letter).length,
      'logic',
    ),
  );

  // Exact integer division.
  const divisions: Array<[number, number]> = [
    [4096, 16], [3465, 15], [9702, 22], [7128, 24], [8640, 12],
  ];
  divisions.forEach(([a, b], i) =>
    push(`gen-div-${i}`, `What is ${a} / ${b}? Reply with only the number.`, a / b),
  );

  // Two-step word problems, where an intermediate slip is invisible in the answer.
  const twoStep: Array<[string, number]> = [
    ['A shop sells pens at 3 for £5. How much do 18 pens cost, in pounds?', 30],
    ['A tank holds 240 litres and is 35% full. How many more litres fit?', 156],
    ['A train travels 180 km in 2.5 hours. What is its average speed in km/h?', 72],
    ['A book has 320 pages. You have read 5/8 of it. How many pages remain?', 120],
    ['Six machines produce 90 units per hour together. How many units does one machine produce per hour?', 15],
    ['A jacket costs £80 and is reduced by 15%, then by a further 10%. What is the final price in pounds?', 61.2],
  ];
  twoStep.forEach(([question, answer], i) =>
    push(`gen-word-${i}`, `${question} Reply with only the number.`, answer, 'computational'),
  );

  // Decimal comparison — the 9.11 vs 9.9 failure, generalised.
  const comparisons: Array<[string, string]> = [
    ['9.11', '9.9'], ['8.7', '8.65'], ['12.3', '12.25'], ['0.5', '0.45'],
  ];
  comparisons.forEach(([a, b], i) =>
    push(
      `gen-cmp-${i}`,
      `Which is larger, ${a} or ${b}? Reply with only the larger number.`,
      Number(a) > Number(b) ? a : b,
      'logic',
    ),
  );

  return out;
}

/** Small helper so the gcd pair list stays readable. */
function surd(n: number): number {
  return n * 111;
}

/** Built-ins plus generated items plus anything in `packages/engine/eval/goldens.jsonl`. */
export function loadGoldens(): Golden[] {
  const custom: Golden[] = [];
  const path = join(ENGINE_ROOT, 'eval', 'goldens.jsonl');

  if (existsSync(path)) {
    for (const [i, line] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      try {
        const item = JSON.parse(trimmed) as Golden;
        if (item.question && item.key !== undefined) custom.push(item);
      } catch {
        throw new Error(`goldens.jsonl line ${i + 1} is not valid JSON`);
      }
    }
  }

  // `cd-4` has an intentionally empty key (JS coerces [] + [] to ""), which the
  // structured judge treats as "no key". Drop it unless the user overrides it.
  return [...BUILT_IN.filter((g) => g.key !== ''), ...generated(), ...custom];
}

/** Ground truth for mock seats, so the harness can run with no provider at all. */
export function oracleFor(goldens: Golden[]): (question: string) => { answer: string; key: string } | null {
  const byQuestion = new Map(goldens.map((g) => [normalise(g.question), g]));
  return (question: string) => {
    const hit = byQuestion.get(normalise(question));
    return hit ? { answer: `The answer is ${hit.key}.`, key: hit.key } : null;
  };
}

function normalise(q: string): string {
  return q.replace(/\s+/g, ' ').trim();
}
