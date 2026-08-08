import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SeatConfig, Stubbornness } from '@consensus/shared';

import { REPO_ROOT } from '../config.js';
import { loadSeats } from '../configStore.js';
import { setLogLevel } from '../util/logger.js';
import { evalToMarkdown, runEval, type Condition } from './harness.js';
import { loadGoldens } from './goldens.js';

/**
 * `npm run eval` — does this protocol actually beat a single good model?
 *
 * It runs with mock seats by default, so it works with zero configuration, no
 * API key and no subscription quota. That matters: the point is to test the
 * premise *before* investing in relay extensions and descriptor packs, and a
 * baseline you cannot run is a baseline nobody runs.
 *
 *   npm run eval                       mock panel, default stubbornness
 *   npm run eval -- --sweep            sweep the agreement-modulation dial
 *   npm run eval -- --real             use the seats configured in the app
 *   npm run eval -- --k 5              self-consistency sample count
 *   npm run eval -- --limit 10         first N golden questions only
 */

/**
 * The default mock panel encodes the failure modes the protocol has to survive:
 * two honest-but-imperfect models, one that folds to the majority, and one that
 * never concedes. A protocol that only works with well-behaved seats is not
 * telling you anything.
 */
const MOCK_PANEL: SeatConfig[] = [
  {
    id: 'mock-alpha',
    displayName: 'Alpha (accurate)',
    adapter: 'mock',
    enabled: true,
    primary: true,
    options: { persona: 'truthful', accuracy: 0.85, seed: 11 },
  },
  {
    id: 'mock-beta',
    displayName: 'Beta (accurate)',
    adapter: 'mock',
    enabled: true,
    options: { persona: 'truthful', accuracy: 0.75, seed: 23 },
  },
  {
    id: 'mock-gamma',
    displayName: 'Gamma (sycophant)',
    adapter: 'mock',
    enabled: true,
    options: { persona: 'sycophant', accuracy: 0.6, seed: 37 },
  },
  {
    id: 'mock-delta',
    displayName: 'Delta (stubborn)',
    adapter: 'mock',
    enabled: true,
    options: { persona: 'stubborn', accuracy: 0.7, seed: 51 },
  },
];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : 'true';
}

async function main(): Promise<void> {
  setLogLevel((arg('log') as 'info') ?? 'warn');

  const useReal = arg('real') === 'true';
  const seats = useReal ? loadSeats().filter((s) => s.enabled) : MOCK_PANEL;
  if (!seats.length) {
    console.error('No enabled seats. Configure a panel first, or drop --real to use the mock panel.');
    process.exit(1);
  }

  const limit = Number(arg('limit') ?? 0);
  const goldens = limit > 0 ? loadGoldens().slice(0, limit) : loadGoldens();

  const sweep: Stubbornness[] | undefined = arg('sweep') === 'true' ? [0, 2, 3, 4] : undefined;
  const conditions = (arg('conditions') ?? 'single,self_consistency,protocol').split(',') as Condition[];

  console.log(
    `Evaluating ${goldens.length} question(s) with ${seats.length} seat(s): ` +
      `${seats.map((s) => s.displayName).join(', ')}`,
  );
  if (!useReal) {
    console.log('Using mock seats — this validates the protocol machinery, not real model accuracy.\n');
  }

  let lastPct = -1;
  const report = await runEval({
    seats,
    goldens,
    conditions,
    k: Number(arg('k') ?? 3),
    stubbornnessSweep: sweep,
    useMockOracle: !useReal,
    concurrency: Number(arg('concurrency') ?? 4),
    onProgress: (done, total, label) => {
      const pct = Math.floor((done / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(`\r  ${pct}%  ${label.padEnd(40).slice(0, 40)}`);
      }
    },
  });
  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  const markdown = evalToMarkdown(report);
  console.log(markdown);

  const outDir = join(REPO_ROOT, 'eval-results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date(report.startedAt).toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(outDir, `${stamp}.md`), markdown, 'utf8');
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify(report, null, 2), 'utf8');
  console.log(`Written to eval-results/${stamp}.{md,json}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
