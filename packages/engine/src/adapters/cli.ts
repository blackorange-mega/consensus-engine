import { spawn } from 'node:child_process';

import type { AdapterKind, Capabilities, TransportFamily } from '@consensus/shared';

import { logger } from '../util/logger.js';
import { AdapterError, DEFAULT_CAPABILITIES, type ModelAdapter, type SendOptions, type SendResult } from './types.js';

const log = logger('adapter:cli');

/**
 * CLI adapters — `claude`, `gemini`, `codex` and friends.
 *
 * Subscription-backed, deterministic, zero UI fragility: no selectors to break,
 * no tab to lose, no login to expire mid-run. This is the best default when the
 * user has them installed, and the right transport to bring up first — it lets
 * the protocol be debugged without fighting the automation layer at the same
 * time.
 */
export interface CliOptions {
  command: string;
  args: string[];
  /** Pipe the prompt on stdin rather than as an argument. Required for long prompts. */
  stdin: boolean;
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Terminal control sequences are not part of the answer, so they are removed.
   * This is the only text mutation any adapter performs, it is declared here,
   * and the conformance fixture proves nothing else changed.
   */
  stripAnsi?: boolean;
  /** Lines matching this are dropped (CLI banners, update notices). */
  dropLinePattern?: string;
}

/**
 * Terminal escape sequences: CSI, OSC and the single-character Fe escapes.
 * Assembled from a string so this source file contains no raw control bytes.
 */
const ANSI_RE = new RegExp(
  [
    '\\u001B\\[[0-9;?]*[ -/]*[@-~]', // CSI - colours, cursor movement
    '\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)', // OSC - titles, hyperlinks
    '\\u001B[@-Z\\\\-_]', // Fe - single-character escapes
  ].join('|'),
  'g',
);

export class CliAdapter implements ModelAdapter {
  readonly kind: AdapterKind = 'cli';
  readonly family: TransportFamily = 'cli';
  readonly capabilities: Capabilities = {
    ...DEFAULT_CAPABILITIES,
    streaming: false,
    rawCopy: true,
    newThread: true,
    // One process per call, so parallel invocations are safe -- but they share
    // one account quota, which the budget layer accounts for separately.
    concurrent: true,
    systemPrompt: false,
    temperature: false,
    quotaVisible: false,
  };

  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly opts: CliOptions,
  ) {}

  async health() {
    try {
      const out = await this.run(['--version'], null, 10_000);
      return { ok: true, detail: out.trim().split('\n')[0] ?? `${this.opts.command} present` };
    } catch (err) {
      return {
        ok: false,
        detail: `${this.opts.command} not runnable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async send(prompt: string, opts: SendOptions): Promise<SendResult> {
    const args = this.opts.stdin ? this.opts.args : [...this.opts.args, prompt];
    const raw = await this.run(args, this.opts.stdin ? prompt : null, opts.timeoutMs, opts.signal);

    let text = raw;
    if (this.opts.stripAnsi !== false) text = text.replace(ANSI_RE, '');
    if (this.opts.dropLinePattern) {
      const re = new RegExp(this.opts.dropLinePattern);
      text = text
        .split('\n')
        .filter((l) => !re.test(l))
        .join('\n');
    }
    // Leading BOM and CRLF are terminal artefacts, not answer content.
    text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();

    if (!text) throw new AdapterError('unknown', `${this.opts.command} produced no output`);

    return { text, via: 'cli', costUsd: 0 };
  }

  private run(args: string[], stdin: string | null, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      // npm-installed CLIs on Windows are .cmd shims and need a shell to resolve.
      const useShell = process.platform === 'win32';

      const child = spawn(this.opts.command, args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...this.opts.env },
        shell: useShell,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new AdapterError('timeout', `${this.opts.command} timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      const onAbort = () => {
        child.kill('SIGKILL');
        finish(() => reject(new AdapterError('aborted', 'run aborted')));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => (stdout += d));
      child.stderr.on('data', (d: string) => (stderr += d));

      child.on('error', (err) =>
        finish(() => reject(new AdapterError('not_configured', `cannot run ${this.opts.command}: ${err.message}`))),
      );

      child.on('close', (code) =>
        finish(() => {
          if (code === 0) return resolve(stdout);
          const blob = `${stdout}\n${stderr}`.toLowerCase();
          if (/rate.?limit|too many requests/.test(blob)) {
            return reject(new AdapterError('rate_limited', `${this.opts.command} is rate limited`, stderr.slice(0, 400)));
          }
          if (/quota|usage limit|out of credit|upgrade your plan/.test(blob)) {
            return reject(new AdapterError('usage_cap', `${this.opts.command} hit a usage cap`, stderr.slice(0, 400)));
          }
          if (/not logged in|unauthori[sz]ed|authenticate|login/.test(blob)) {
            return reject(new AdapterError('login_expired', `${this.opts.command} is not logged in`, stderr.slice(0, 400)));
          }
          reject(new AdapterError('unknown', `${this.opts.command} exited ${code}`, stderr.slice(0, 400)));
        }),
      );

      if (stdin !== null) {
        child.stdin.on('error', () => log.debug(`${this.opts.command} closed stdin early`));
        child.stdin.end(stdin, 'utf8');
      } else {
        child.stdin.end();
      }
    });
  }
}

/** Known-good invocations. `stdin: true` everywhere so a 10k-char prompt cannot blow the arg limit. */
export const CLI_PRESETS: Record<string, Omit<CliOptions, 'cwd' | 'env'>> = {
  claude: { command: 'claude', args: ['-p'], stdin: true, stripAnsi: true },
  gemini: { command: 'gemini', args: ['-p'], stdin: true, stripAnsi: true },
  codex: { command: 'codex', args: ['exec', '-'], stdin: true, stripAnsi: true },
  ollama: { command: 'ollama', args: ['run'], stdin: true, stripAnsi: true },
};
