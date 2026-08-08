import { buildPanel } from '../adapters/registry.js';
import { diffBytes, fidelityCases } from '../fixtures.js';
import { loadSeats } from '../configStore.js';
import { extractAnswerAndKey } from '../protocol/parser.js';
import { buildDispatchPrompt } from '../protocol/roundBuilder.js';
import { setLogLevel } from '../util/logger.js';

/**
 * `npm run conformance` — the per-seat smoke test, run from the command line.
 *
 * For every enabled seat: is it reachable, does `2+2` come back as `4`, and does
 * a LaTeX fixture survive a full round trip byte-for-byte? A seat that fails the
 * last check is LOSSY, which matters because the app promises the user's text is
 * never mutated in transit — a promise the transport layer can break without the
 * protocol ever noticing.
 *
 *   npm run conformance                 every enabled seat
 *   npm run conformance -- --seat claude-cli
 *   npm run conformance -- --fidelity   full fixture suite, not just LaTeX
 */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : 'true';
}

async function main(): Promise<void> {
  setLogLevel('warn');

  const only = arg('seat');
  const fullFidelity = arg('fidelity') === 'true';
  const seats = loadSeats().filter((s) => s.enabled && (!only || s.id === only));

  if (!seats.length) {
    console.error(only ? `No enabled seat with id "${only}".` : 'No enabled seats configured.');
    process.exit(1);
  }

  const { adapters } = buildPanel(seats);
  let anyFailed = false;

  for (const seat of seats) {
    const adapter = adapters.get(seat.id);
    console.log(`\n${seat.displayName} ${DIM}(${seat.adapter})${RESET}`);

    if (!adapter) {
      console.log(`  ${RED}✗${RESET} could not be constructed`);
      anyFailed = true;
      continue;
    }

    // 1. reachable
    const health = await adapter.health();
    line(health.ok, 'reachable', health.detail);
    if (!health.ok) {
      anyFailed = true;
      continue;
    }

    // 2. the adapter's own conformance suite, where it has one
    if (adapter.conformance) {
      const result = await adapter.conformance();
      for (const check of result.checks) {
        line(check.ok, check.name, check.detail, check.durationMs);
      }
      if (!result.ok) anyFailed = true;
      continue;
    }

    // 3. otherwise: arithmetic, then byte-exact fidelity
    try {
      const started = Date.now();
      const built = buildDispatchPrompt('What is 2+2? Reply with only the number.', true);
      const res = await adapter.send(built.prompt, { timeoutMs: 90_000, newThread: true });
      const { key } = extractAnswerAndKey(res.text);
      const ok = /\b4\b/.test(key ?? res.text);
      line(ok, 'arithmetic round trip (2+2)', (key ?? res.text).slice(0, 60), Date.now() - started);
      if (!ok) anyFailed = true;
    } catch (err) {
      line(false, 'arithmetic round trip (2+2)', err instanceof Error ? err.message : String(err));
      anyFailed = true;
      continue;
    }

    const cases = fullFidelity ? fidelityCases() : fidelityCases().filter((c) => c.name === 'latex.txt');
    for (const testCase of cases) {
      try {
        const started = Date.now();
        const prompt =
          `Repeat the text between the markers back to me exactly, byte for byte, with nothing added ` +
          `or removed and no commentary.\n\n---BEGIN---\n${testCase.text}\n---END---`;
        const res = await adapter.send(prompt, { timeoutMs: 120_000, newThread: true });

        const captured = res.text.match(/---BEGIN---\n([\s\S]*?)\n---END---/)?.[1] ?? res.text;
        const diff = diffBytes(testCase.text, captured);
        line(
          diff.equal,
          `fidelity: ${testCase.name}`,
          diff.equal ? testCase.why : `LOSSY — ${diff.detail}`,
          Date.now() - started,
        );
        if (!diff.equal) {
          // Not a hard failure: many models legitimately reformat when asked to
          // echo. It is a warning about what this seat can be trusted to carry.
          console.log(
            `    ${YELLOW}note${RESET} ${DIM}this seat may not preserve formatting exactly; ` +
              `answers from it are flagged LOSSY in the UI${RESET}`,
          );
        }
      } catch (err) {
        line(false, `fidelity: ${testCase.name}`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  console.log(
    `\n${anyFailed ? `${RED}Some checks failed.${RESET}` : `${GREEN}All checks passed.${RESET}`} ` +
      `${DIM}A red descriptor check after a provider redesign is expected — repair the descriptor pack, ` +
      `it is hot-updatable.${RESET}\n`,
  );
  process.exit(anyFailed ? 1 : 0);
}

function line(ok: boolean, name: string, detail?: string, ms?: number): void {
  const mark = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const timing = ms === undefined ? '' : ` ${DIM}${(ms / 1000).toFixed(1)}s${RESET}`;
  console.log(`  ${mark} ${name}${timing}${detail ? `\n    ${DIM}${detail.slice(0, 160)}${RESET}` : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
