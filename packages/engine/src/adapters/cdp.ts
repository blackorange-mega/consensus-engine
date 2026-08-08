import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import WebSocket from 'ws';

import type {
  AdapterKind,
  Capabilities,
  ConformanceResult,
  ExtractionPath,
  RelayAction,
  SiteDescriptor,
  TransportFamily,
} from '@consensus/shared';

import { REPO_ROOT } from '../config.js';
import { readFixture } from '../fixtures.js';
import { jitter, sleep } from '../util/async.js';
import { logger } from '../util/logger.js';
import { AdapterError, DEFAULT_CAPABILITIES, type ModelAdapter, type SendOptions, type SendResult } from './types.js';

const log = logger('adapter:cdp');

/** The page-side engine, shared verbatim with the extension. */
const PAGE_SCRIPTS = ['clipboard-shim.js', 'page-core.js'];
const EXTENSION_SRC = join(REPO_ROOT, 'packages', 'extension', 'src');

let cachedScripts: string | null = null;
function pageScripts(): string {
  if (cachedScripts) return cachedScripts;
  cachedScripts = PAGE_SCRIPTS.map((f) => {
    const path = join(EXTENSION_SRC, f);
    if (!existsSync(path)) throw new Error(`page script missing: ${path}`);
    return readFileSync(path, 'utf8');
  }).join('\n;\n');
  return cachedScripts;
}

export interface CdpOptions {
  provider: string;
  /** DevTools port. Chrome must have been started with --remote-debugging-port. */
  port: number;
  host?: string;
  /**
   * Launch a browser ourselves rather than attaching to a running one.
   * With `profileDir` set this drives an app-owned profile: one the user logs
   * into once, fully isolated from their daily browsing
   * and safe for unattended runs.
   */
  launch?: boolean;
  browserPath?: string;
  profileDir?: string;
  headless?: boolean;
  freshThreadPerCall?: boolean;
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Chrome DevTools Protocol transport: attach to a running browser, or drive a
 * dedicated app-owned profile.
 *
 * Where the extension relay asks Chrome politely from inside, this attaches
 * from outside over CDP. It buys things the extension cannot have:
 *
 *   - it works on a browser the user starts themselves with a debugging port,
 *     against their real profile and real logged-in sessions;
 *   - it can drive a dedicated, app-owned profile for unattended or scheduled
 *     runs, fully isolated from daily browsing;
 *   - it runs headless, so a run needs no visible window at all;
 *   - it has no service-worker lifecycle to fight.
 *
 * It costs a browser restart with a flag, which is why the extension relay is
 * still the default. Both drive the *same* page-side engine (`page-core.js`),
 * so completion detection and non-lossy extraction behave identically and
 * cannot drift apart.
 *
 * Implemented against raw CDP over a WebSocket rather than Playwright: the only
 * primitives needed are target discovery and `Runtime.evaluate`, and a
 * ~200 MB browser-automation dependency is a poor trade for an app that already
 * holds access to the user's authenticated sessions.
 */
export class CdpAdapter implements ModelAdapter {
  readonly kind: AdapterKind = 'cdp';
  readonly family: TransportFamily = 'relay';
  readonly capabilities: Capabilities;

  private socket: WebSocket | null = null;
  private targetId: string | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private browser: ChildProcess | null = null;
  private deltaSink: ((text: string) => void) | null = null;

  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly descriptor: SiteDescriptor,
    private readonly opts: CdpOptions,
  ) {
    this.capabilities = {
      ...DEFAULT_CAPABILITIES,
      streaming: true,
      rawCopy: descriptor.assumptions.copyYieldsMarkdown === 'verified',
      newThread: true,
      concurrent: false, // one conversation at a time per provider account
      systemPrompt: false,
      temperature: false,
      attachments: false,
      quotaVisible: true,
    };
  }

  private get base(): string {
    return `http://${this.opts.host ?? '127.0.0.1'}:${this.opts.port}`;
  }

  /* ----------------------------------------------------------------- health */

  async health() {
    try {
      const version = await this.httpJson<{ Browser?: string }>('/json/version');
      const target = await this.findTarget();
      return {
        ok: Boolean(target),
        detail: target
          ? `${version.Browser ?? 'browser'} attached — ${new URL(target.url).host}`
          : `${version.Browser ?? 'browser'} reachable, but no tab is open on ${this.descriptor.origins[0]}`,
      };
    } catch (err) {
      if (this.opts.launch) {
        return { ok: false, detail: `could not start or reach a browser on port ${this.opts.port}` };
      }
      return {
        ok: false,
        detail:
          `nothing is listening on ${this.base}. Start your browser with ` +
          `--remote-debugging-port=${this.opts.port}, or enable launch mode for a dedicated profile.`,
      };
    }
  }

  /* ------------------------------------------------------------------ send */

  async send(prompt: string, opts: SendOptions): Promise<SendResult> {
    await this.ensureAttached();

    if (opts.newThread || this.opts.freshThreadPerCall) {
      await this.act({ kind: 'newThread', provider: this.opts.provider }, 45_000);
      await this.waitForLoad();
      await this.inject();
    }

    // Human-plausible pacing: about not tripping abuse heuristics on the user's
    // own account, not about defeating them.
    const pause = jitter(this.descriptor.pacingMs);
    if (pause > 0) await sleep(pause, opts.signal);

    await this.act({ kind: 'send', provider: this.opts.provider, text: prompt, verifyEcho: true }, 60_000);

    this.deltaSink = opts.onDelta ?? null;
    try {
      const result = await this.act(
        { kind: 'awaitAndExtract', provider: this.opts.provider, timeoutMs: opts.timeoutMs },
        opts.timeoutMs + 15_000,
      );
      if (result.lossy) {
        log.warn(`${this.id}: answer extracted via ${result.via}; formatting fidelity is not guaranteed`);
      }
      return { text: result.text, lossy: result.lossy, via: result.via };
    } finally {
      this.deltaSink = null;
    }
  }

  async conformance(): Promise<ConformanceResult> {
    const at = Date.now();
    const checks: ConformanceResult['checks'] = [];

    const run = async (name: string, fn: () => Promise<{ ok: boolean; detail?: string }>) => {
      const started = Date.now();
      try {
        const res = await fn();
        checks.push({ name, ok: res.ok, detail: res.detail, durationMs: Date.now() - started });
      } catch (err) {
        checks.push({
          name,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started,
        });
      }
    };

    await run('browser reachable over CDP', async () => this.health());

    await run('selectors resolve on the live page', async () => {
      await this.ensureAttached();
      const probe = (await this.evaluate(
        `JSON.stringify(window.__consensusRelay.probeSelectors(${JSON.stringify(this.descriptor)}))`,
      )) as string;
      const found = JSON.parse(probe) as Record<string, boolean | number>;
      const missing = Object.entries(found)
        .filter(([, v]) => v === false || v === 0)
        .map(([k]) => k);
      return {
        ok: missing.length === 0,
        detail: missing.length ? `descriptor is stale — no match for: ${missing.join(', ')}` : 'all selectors matched',
      };
    });

    await run('arithmetic round trip (2+2)', async () => {
      const out = await this.send('What is 2+2? Reply with only the number.', { timeoutMs: 90_000 });
      return { ok: /\b4\b/.test(out.text), detail: out.text.slice(0, 80) };
    });

    await run('LaTeX byte-exact round trip via copy button', async () => {
      const fixture = readFixture('latex.txt');
      await this.ensureAttached();
      const res = await this.act(
        { kind: 'conformance', provider: this.opts.provider, fixture, expect: fixture },
        120_000,
      );
      const exact = res.text === fixture;
      return {
        ok: exact,
        detail: exact ? `byte-exact via ${res.via}` : `NOT byte-exact via ${res.via}; this seat is marked LOSSY`,
      };
    });

    return { ok: checks.every((c) => c.ok), at, checks };
  }

  async dispose(): Promise<void> {
    this.socket?.close();
    this.socket = null;
    // Only a browser we started is ours to stop.
    if (this.browser) {
      this.browser.kill();
      this.browser = null;
    }
  }

  /* ------------------------------------------------------------ CDP plumbing */

  private async httpJson<T>(path: string, method: 'GET' | 'PUT' = 'GET'): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(`${this.base}${path}`, { method, signal: controller.signal });
      if (!res.ok) throw new AdapterError('network', `CDP ${path} returned ${res.status}`);
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async findTarget(): Promise<CdpTarget | null> {
    const targets = await this.httpJson<CdpTarget[]>('/json/list');
    const match = targets.find(
      (t) =>
        t.type === 'page' &&
        t.webSocketDebuggerUrl &&
        this.descriptor.origins.some((origin) => t.url.startsWith(origin)),
    );
    return match ?? null;
  }

  private async ensureAttached(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN && this.targetId) {
      // Cheap liveness check; a closed tab shows up as an evaluate failure.
      try {
        await this.evaluate('1');
        return;
      } catch {
        this.socket.close();
        this.socket = null;
      }
    }

    if (this.opts.launch) await this.ensureBrowser();

    let target = await this.findTarget();
    if (!target) {
      // Open the provider in a new tab and wait for it to become a real target.
      await this.httpJson(`/json/new?${encodeURIComponent(this.descriptor.newThreadUrl)}`, 'PUT').catch(
        () => this.httpJson(`/json/new?${encodeURIComponent(this.descriptor.newThreadUrl)}`, 'GET'),
      );
      for (let i = 0; i < 25 && !target; i++) {
        await sleep(400);
        target = await this.findTarget();
      }
    }
    if (!target?.webSocketDebuggerUrl) {
      throw new AdapterError(
        'not_configured',
        `no ${this.descriptor.displayName} tab is available over CDP on port ${this.opts.port}`,
      );
    }

    await this.connect(target);
    await this.waitForLoad();
    await this.inject();
  }

  private connect(target: CdpTarget): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl!, { maxPayload: 256 * 1024 * 1024 });
      const timer = setTimeout(() => reject(new AdapterError('timeout', 'CDP connection timed out')), 15_000);

      ws.on('open', () => {
        clearTimeout(timer);
        this.socket = ws;
        this.targetId = target.id;
        log.info(`${this.id}: attached to ${new URL(target.url).host}`);
        resolve();
      });

      ws.on('message', (data) => this.onMessage(String(data)));

      ws.on('close', () => {
        if (this.socket === ws) {
          this.socket = null;
          this.targetId = null;
        }
        for (const [, p] of this.pending) p.reject(new AdapterError('network', 'CDP connection closed'));
        this.pending.clear();
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new AdapterError('network', `CDP socket error: ${err.message}`));
      });
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Streaming deltas arrive through a page binding.
    if (msg.method === 'Runtime.bindingCalled') {
      const params = msg.params as { name?: string; payload?: string } | undefined;
      if (params?.name === '__consensusDelta' && params.payload) this.deltaSink?.(params.payload);
      return;
    }

    if (msg.id === undefined) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);

    if (msg.error) pending.reject(new AdapterError('unknown', `CDP error: ${msg.error.message ?? 'unknown'}`));
    else pending.resolve(msg.result);
  }

  private call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new AdapterError('network', 'not attached to a browser target'));
    }
    const id = ++this.seq;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterError('timeout', `CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      // Attached directly to the page target, so commands need no sessionId.
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private async evaluate(expression: string, timeoutMs = 30_000): Promise<unknown> {
    const result = await this.call<{
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);

    if (result.exceptionDetails) {
      const message =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'page threw';
      throw new AdapterError('unknown', `page evaluation failed: ${String(message).slice(0, 300)}`);
    }
    return result.result?.value;
  }

  private async waitForLoad(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = (await this.evaluate('document.readyState', 5_000)) as string;
        if (state === 'complete' || state === 'interactive') return;
      } catch {
        /* target may still be swapping documents */
      }
      await sleep(300);
    }
  }

  /** Inject the shared page-side engine and the delta binding. */
  private async inject(): Promise<void> {
    await this.call('Runtime.enable', {}, 10_000).catch(() => undefined);
    await this.call('Runtime.addBinding', { name: '__consensusDelta' }, 10_000).catch(() => undefined);

    const alreadyThere = await this.evaluate('Boolean(window.__consensusRelay)', 10_000).catch(() => false);
    if (alreadyThere === true) return;

    await this.evaluate(pageScripts(), 20_000);

    const ok = await this.evaluate('Boolean(window.__consensusRelay)', 10_000);
    if (ok !== true) throw new AdapterError('not_configured', 'the page-side engine failed to install');
  }

  /**
   * Run one fixed action in the page.
   *
   * Note what is and is not being sent: the *action* and the *descriptor* are
   * serialised in, and the page-side engine decides what to do with them. There
   * is no path here for arbitrary caller-supplied code, and no model output ever
   * reaches this function.
   */
  private async act(
    action: RelayAction,
    timeoutMs: number,
  ): Promise<{ text: string; lossy: boolean; via: ExtractionPath }> {
    await this.inject();

    const expression = `window.__consensusRelay.handle(
      ${JSON.stringify(action)},
      ${JSON.stringify(this.descriptor)},
      (t) => { try { __consensusDelta(t); } catch (e) {} }
    ).then(r => JSON.stringify(r))`;

    const raw = (await this.evaluate(expression, timeoutMs)) as string | undefined;
    if (!raw) throw new AdapterError('unknown', `relay action "${action.kind}" returned nothing`);

    const result = JSON.parse(raw) as
      | { ok: true; text: string; lossy: boolean; via: ExtractionPath }
      | { ok: false; reason: string; detail?: string };

    if (!result.ok) {
      throw new AdapterError(result.reason as never, `relay ${action.kind} failed`, result.detail);
    }
    return { text: result.text, lossy: result.lossy, via: result.via };
  }

  /* -------------------------------------------------- dedicated profile mode */

  private async ensureBrowser(): Promise<void> {
    try {
      await this.httpJson('/json/version');
      return; // something is already listening
    } catch {
      /* need to start one */
    }
    if (this.browser) return;

    const binary = this.opts.browserPath ?? findChrome();
    if (!binary) {
      throw new AdapterError(
        'not_configured',
        'no browser binary found — set browserPath for this seat',
      );
    }

    const args = [
      `--remote-debugging-port=${this.opts.port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
    ];
    if (this.opts.profileDir) args.push(`--user-data-dir=${this.opts.profileDir}`);
    if (this.opts.headless) args.push('--headless=new');
    args.push(this.descriptor.newThreadUrl);

    log.info(`${this.id}: launching ${binary} on debugging port ${this.opts.port}`);
    this.browser = spawn(binary, args, { detached: false, stdio: 'ignore', windowsHide: true });
    this.browser.on('exit', () => {
      this.browser = null;
    });

    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        await this.httpJson('/json/version');
        return;
      } catch {
        /* still starting */
      }
    }
    throw new AdapterError('network', `browser did not expose a debugging port within 20s`);
  }
}

/** Best-effort discovery of an installed Chromium-family browser. */
export function findChrome(): string | null {
  const candidates: string[] =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];

  return candidates.find((p) => p && existsSync(p)) ?? null;
}
