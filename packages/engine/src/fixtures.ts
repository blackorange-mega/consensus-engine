import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { FIXTURE_DIR } from './config.js';

/**
 * Text-fidelity fixtures.
 *
 * These must survive a full round trip byte-for-byte through every adapter,
 * including every UI-driven seat. They are a hard gate, not a nice-to-have:
 * if a transport mangles LaTeX or reorders RTL text, the consensus premise is
 * already broken before any model has said anything.
 */

export function readFixture(name: string): string {
  const path = join(FIXTURE_DIR, name);
  if (!existsSync(path)) throw new Error(`fixture not found: ${name}`);
  // Read as bytes and decode explicitly: no BOM stripping, no newline rewriting.
  return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
}

export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.txt')).sort();
}

/**
 * The 10k-character fixture is generated rather than stored, so it stays
 * exactly 10,000 code points regardless of how the repo is checked out.
 */
export function longFixture(chars = 10_000): string {
  const unit =
    'Paragraph {n}: the quick brown fox jumps over the lazy dog — ' +
    'ligne accentuée, Grüße, naïve café, 日本語のテキスト, 🌍 §12.3. ';
  let out = '';
  let n = 1;
  while (out.length < chars) out += unit.replace('{n}', String(n++));
  return out.slice(0, chars);
}

export interface FidelityCase {
  name: string;
  text: string;
  /** What this case is actually testing, for the report. */
  why: string;
}

export function fidelityCases(): FidelityCase[] {
  return [
    { name: 'latex.txt', text: readFixture('latex.txt'), why: 'LaTeX, backslashes and math delimiters' },
    { name: 'code.txt', text: readFixture('code.txt'), why: 'nested code fences and backticks' },
    { name: 'rtl.txt', text: readFixture('rtl.txt'), why: 'Persian RTL text and bidi marks' },
    { name: 'unicode.txt', text: readFixture('unicode.txt'), why: 'emoji, ZWJ sequences and combining marks' },
    { name: 'long', text: longFixture(), why: '10,000-character payload' },
  ];
}

/** Byte-for-byte comparison with a first-difference report. */
export function diffBytes(expected: string, actual: string): { equal: boolean; detail?: string } {
  if (expected === actual) return { equal: true };
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  const context = (buf: Buffer) => JSON.stringify(buf.subarray(Math.max(0, i - 20), i + 20).toString('utf8'));
  return {
    equal: false,
    detail:
      `first difference at byte ${i} (expected ${a.length} bytes, got ${b.length}); ` +
      `expected ${context(a)} but got ${context(b)}`,
  };
}
