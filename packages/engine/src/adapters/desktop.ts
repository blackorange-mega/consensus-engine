import { spawn } from 'node:child_process';

import type { AdapterKind, Capabilities, ConformanceResult, TransportFamily } from '@consensus/shared';

import { logger } from '../util/logger.js';
import { AdapterError, DEFAULT_CAPABILITIES, type ModelAdapter, type SendOptions, type SendResult } from './types.js';

const log = logger('adapter:desktop');

/**
 * Native desktop app control — for the installed ChatGPT and
 * Claude desktop apps and any other native LLM client.
 *
 * Design decision: do NOT write three OS backends here.
 * Accessibility automation is a large, OS-specific, fast-moving
 * problem (macOS AXUIElement, Windows UI Automation, Linux AT-SPI) and there is
 * a good open-source implementation to build on. So this adapter speaks a small
 * JSON-over-stdio protocol to an external driver process, which the user points
 * at trycua/cua, a PowerShell UIA script, or anything else that implements the
 * five verbs below.
 *
 * What this buys, versus baking one OS in:
 *   - the driver can be swapped or upgraded without touching the engine;
 *   - the engine keeps the security boundary absolute — the verb set is
 *     fixed and enumerable, so no model output can ever become an action;
 *   - a missing driver is a clean `not_configured` seat, not a crash.
 *
 * Driver protocol — one JSON object per line on stdin, one per line on stdout:
 *   -> {"id":"1","verb":"probe","app":"ChatGPT"}
 *   <- {"id":"1","ok":true,"detail":"window found, accessibility tree readable"}
 *   -> {"id":"2","verb":"newThread","app":"ChatGPT"}
 *   -> {"id":"3","verb":"send","app":"ChatGPT","text":"...","verifyEcho":true}
 *   -> {"id":"4","verb":"awaitAndExtract","app":"ChatGPT","timeoutMs":180000}
 *   <- {"id":"4","ok":true,"text":"...","lossy":false}
 *   -> {"id":"5","verb":"abort"}
 *
 * Driver requirements, non-negotiable:
 *   - use accessibility APIs, not pixel-clicking, so it works with the window
 *     occluded and does not hijack the user's cursor or steal focus;
 *   - never interact with a window outside the registered allow-list;
 *   - never close or minimise a user window;
 *   - honour `abort` immediately (the global kill switch depends on it).
 */
export interface DesktopOptions {
  /** Registered application name. The driver must refuse anything not on the list. */
  app: string;
  /** Driver executable. Absent = seat reports `not_configured`. */
  driverCommand?: string;
  driverArgs?: string[];
  /** Require a confirm step before the first send to a newly-added app. */
  confirmFirstSend?: boolean;
}

interface DriverReply {
  id: string;
  ok: boolean;
  text?: string;
  detail?: string;
  lossy?: boolean;
  reason?: string;
}

export class DesktopAdapter implements ModelAdapter {
  readonly kind: AdapterKind = 'desktop';
  readonly family: TransportFamily = 'desktop';
  readonly capabilities: Capabilities = {
    ...DEFAULT_CAPABILITIES,
    streaming: false,
    rawCopy: false, // proven per app by the conformance test, never assumed
    newThread: true,
    concurrent: false, // one conversation at a time inside one desktop app
    systemPrompt: false,
    temperature: false,
    quotaVisible: false,
  };

  private child: ReturnType<typeof spawn> | null = null;
  private pending = new Map<string, (reply: DriverReply) => void>();
  private seq = 0;
  private buffer = '';
  private firstSendConfirmed = false;

  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly opts: DesktopOptions,
  ) {}

  async health() {
    if (!this.opts.driverCommand) {
      return {
        ok: false,
        detail:
          'no accessibility driver configured — set driverCommand to a computer-use driver ' +
          '(for example trycua/cua) that speaks the JSON-over-stdio verb set',
      };
    }
    try {
      const reply = await this.call({ verb: 'probe', app: this.opts.app }, 20_000);
      return { ok: reply.ok, detail: reply.detail ?? `${this.opts.app} reachable` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async send(prompt: string, opts: SendOptions): Promise<SendResult> {
    if (!this.opts.driverCommand) {
      throw new AdapterError('not_configured', `no accessibility driver configured for ${this.opts.app}`);
    }
    if (this.opts.confirmFirstSend && !this.firstSendConfirmed) {
      throw new AdapterError(
        'not_configured',
        `${this.opts.app} has not been confirmed for automation yet — approve it in the transport health strip first`,
      );
    }

    if (opts.newThread) await this.call({ verb: 'newThread', app: this.opts.app }, 30_000);

    // verifyEcho: the driver must read the composer back and refuse to submit
    // unless it matches the source string byte-for-byte.
    await this.call({ verb: 'send', app: this.opts.app, text: prompt, verifyEcho: true }, 60_000);

    const reply = await this.call(
      { verb: 'awaitAndExtract', app: this.opts.app, timeoutMs: opts.timeoutMs },
      opts.timeoutMs + 15_000,
    );

    if (!reply.ok || typeof reply.text !== 'string') {
      throw new AdapterError((reply.reason as never) ?? 'unknown', reply.detail ?? 'driver returned no text');
    }
    if (reply.lossy) log.warn(`${this.id}: desktop extraction was lossy for ${this.opts.app}`);

    return { text: reply.text, lossy: reply.lossy ?? false, via: 'desktop' };
  }

  /** Approve this app for automation. Mirrors Hermes's confirm-before-first-send guardrail. */
  confirmAutomation(): void {
    this.firstSendConfirmed = true;
  }

  async conformance(): Promise<ConformanceResult> {
    const at = Date.now();
    const checks: ConformanceResult['checks'] = [];

    const probe = await this.health();
    checks.push({ name: 'driver reachable', ok: probe.ok, detail: probe.detail });

    if (probe.ok) {
      const started = Date.now();
      try {
        const out = await this.send('What is 2+2? Reply with only the number.', { timeoutMs: 90_000 });
        checks.push({
          name: 'arithmetic round trip (2+2)',
          ok: /\b4\b/.test(out.text),
          detail: out.text.slice(0, 80),
          durationMs: Date.now() - started,
        });
      } catch (err) {
        checks.push({
          name: 'arithmetic round trip (2+2)',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started,
        });
      }
    }

    return { ok: checks.every((c) => c.ok), at, checks };
  }

  async dispose(): Promise<void> {
    if (!this.child) return;
    try {
      await this.call({ verb: 'abort' }, 3_000);
    } catch {
      /* the driver may already be gone */
    }
    this.child.kill();
    this.child = null;
  }

  /* --------------------------------------------------------------- driver */

  private ensureDriver(): ReturnType<typeof spawn> {
    if (this.child && !this.child.killed) return this.child;

    const child = spawn(this.opts.driverCommand!, this.opts.driverArgs ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const reply = JSON.parse(line) as DriverReply;
          this.pending.get(reply.id)?.(reply);
          this.pending.delete(reply.id);
        } catch {
          log.debug(`driver emitted a non-JSON line: ${line.slice(0, 120)}`);
        }
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => log.debug(`driver stderr: ${d.trim().slice(0, 200)}`));
    child.on('exit', (code) => {
      log.warn(`accessibility driver exited (${code})`);
      for (const [, resolve] of this.pending) {
        resolve({ id: '', ok: false, detail: 'driver exited', reason: 'network' });
      }
      this.pending.clear();
      this.child = null;
    });

    this.child = child;
    return child;
  }

  private call(verb: Record<string, unknown>, timeoutMs: number): Promise<DriverReply> {
    const child = this.ensureDriver();
    const id = String(++this.seq);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterError('timeout', `desktop driver did not answer "${verb.verb}" in ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });

      child.stdin?.write(JSON.stringify({ id, ...verb }) + '\n', 'utf8');
    });
  }
}
