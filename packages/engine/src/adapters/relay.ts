import type {
  AdapterKind,
  Capabilities,
  ConformanceResult,
  ExtractionPath,
  RelayAction,
  SeatFailureReason,
  SiteDescriptor,
  TransportFamily,
} from '@consensus/shared';

import { readFixture } from '../fixtures.js';
import { jitter } from '../util/async.js';
import { logger } from '../util/logger.js';
import { AdapterError, DEFAULT_CAPABILITIES, type ModelAdapter, type SendOptions, type SendResult } from './types.js';

const log = logger('adapter:relay');

/** What the relay server exposes to adapters. Implemented in server/relayServer.ts. */
export interface RelayHub {
  connected(): boolean;
  descriptorFor(provider: string): SiteDescriptor | undefined;
  request(
    seatId: string,
    action: RelayAction,
    timeoutMs: number,
    onDelta?: (text: string) => void,
  ): Promise<
    | { ok: true; text: string; lossy: boolean; via: ExtractionPath }
    | { ok: false; reason: SeatFailureReason; detail?: string }
  >;
}

export interface RelayOptions {
  /** Provider id, matching a descriptor in the pack. */
  provider: string;
  /** Force a fresh conversation for every call. */
  freshThreadPerCall?: boolean;
}

/**
 * The flagship transport.
 *
 * It drives the user's real, already-authenticated browser session, so a panel
 * seat is a live ChatGPT/Claude/Gemini/Grok subscription rather than an API
 * key. That combination — a deliberation protocol seated on the user's own
 * logged-in sessions — is the single strongest claim this app has.
 *
 * Critically this is a TRANSPORT, not an agent. It delivers an exact
 * string and retrieves an exact string. No model decides what to click; the
 * action set is fixed and enumerable, and the descriptors only say where the
 * fixed actions apply.
 */
export class RelayAdapter implements ModelAdapter {
  readonly kind: AdapterKind = 'relay';
  readonly family: TransportFamily = 'relay';
  readonly capabilities: Capabilities;

  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly hub: RelayHub,
    private readonly opts: RelayOptions,
  ) {
    const descriptor = hub.descriptorFor(opts.provider);
    this.capabilities = {
      ...DEFAULT_CAPABILITIES,
      streaming: true,
      // Only true when the provider's copy button is *proven* to yield source
      // markdown. This is an assumption about someone else's UI, so it must be
      // verified per provider, not taken on trust.
      rawCopy: descriptor?.assumptions.copyYieldsMarkdown === 'verified',
      newThread: true,
      // One conversation at a time per provider account: four sites at once is
      // fine, four concurrent chats on one account is how you trip limits.
      concurrent: false,
      systemPrompt: false,
      temperature: false,
      attachments: false,
      quotaVisible: true,
    };
  }

  async health() {
    if (!this.hub.connected()) {
      return { ok: false, detail: 'relay extension is not connected' };
    }
    const descriptor = this.hub.descriptorFor(this.opts.provider);
    if (!descriptor) {
      return { ok: false, detail: `no descriptor for provider "${this.opts.provider}"` };
    }
    const res = await this.hub.request(this.id, { kind: 'probe', provider: this.opts.provider }, 20_000);
    return res.ok
      ? { ok: true, detail: res.text || 'tab reachable and logged in' }
      : { ok: false, detail: res.detail ?? res.reason };
  }

  async send(prompt: string, opts: SendOptions): Promise<SendResult> {
    if (!this.hub.connected()) {
      throw new AdapterError('not_configured', 'the relay extension is not connected');
    }
    const descriptor = this.hub.descriptorFor(this.opts.provider);
    if (!descriptor) {
      throw new AdapterError('not_configured', `no descriptor for provider "${this.opts.provider}"`);
    }

    // Keep one tab per seat warm across rounds; page loads are the slowest and
    // most failure-prone step.
    await this.act({ kind: 'ensureTab', provider: this.opts.provider, url: descriptor.newThreadUrl }, 45_000);

    if (opts.newThread || this.opts.freshThreadPerCall) {
      await this.act({ kind: 'newThread', provider: this.opts.provider }, 45_000);
    }

    // Human-plausible pacing: this is about not tripping abuse heuristics on the
    // user's own account, not about defeating them.
    const pause = jitter(descriptor.pacingMs);
    if (pause > 0) await new Promise((r) => setTimeout(r, pause));

    // `verifyEcho` makes the extension read the composer back and refuse to
    // submit unless it matches the source string byte-for-byte.
    await this.act({ kind: 'send', provider: this.opts.provider, text: prompt, verifyEcho: true }, 60_000);

    const result = await this.act(
      { kind: 'awaitAndExtract', provider: this.opts.provider, timeoutMs: opts.timeoutMs },
      opts.timeoutMs + 15_000,
      opts.onDelta,
    );

    if (result.lossy) {
      log.warn(`${this.id}: answer extracted via ${result.via}; formatting fidelity is not guaranteed`);
    }

    return { text: result.text, lossy: result.lossy, via: result.via };
  }

  /**
   * Conformance smoke test, run on launch for every enabled seat.
   * The first assertion is the one that matters most: round-trip a LaTeX
   * fixture through the copy button and diff it byte-for-byte.
   */
  async conformance(): Promise<ConformanceResult> {
    const checks: ConformanceResult['checks'] = [];
    const at = Date.now();

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

    await run('descriptor present', async () => {
      const d = this.hub.descriptorFor(this.opts.provider);
      return { ok: Boolean(d), detail: d ? `descriptor for ${d.displayName}` : 'missing' };
    });

    await run('tab reachable and logged in', async () => {
      const res = await this.hub.request(this.id, { kind: 'probe', provider: this.opts.provider }, 20_000);
      return { ok: res.ok, detail: res.ok ? res.text : res.detail };
    });

    await run('arithmetic round trip (2+2)', async () => {
      const out = await this.send('What is 2+2? Reply with only the number.', { timeoutMs: 90_000 });
      return { ok: /\b4\b/.test(out.text), detail: out.text.slice(0, 80) };
    });

    await run('LaTeX byte-exact round trip via copy button', async () => {
      const fixture = readFixture('latex.txt');
      const res = await this.hub.request(
        this.id,
        { kind: 'conformance', provider: this.opts.provider, fixture, expect: fixture },
        120_000,
      );
      if (!res.ok) return { ok: false, detail: res.detail ?? res.reason };
      const exact = res.text === fixture;
      return {
        ok: exact,
        detail: exact
          ? `byte-exact via ${res.via}`
          : `NOT byte-exact via ${res.via}; this seat is marked LOSSY`,
      };
    });

    return { ok: checks.every((c) => c.ok), at, checks };
  }

  private async act(
    action: RelayAction,
    timeoutMs: number,
    onDelta?: (text: string) => void,
  ): Promise<{ text: string; lossy: boolean; via: ExtractionPath }> {
    const res = await this.hub.request(this.id, action, timeoutMs, onDelta);
    if (!res.ok) throw new AdapterError(res.reason, `relay ${action.kind} failed`, res.detail);
    return { text: res.text, lossy: res.lossy, via: res.via };
  }
}
