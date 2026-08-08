import type { AdapterKind, Capabilities, ConformanceResult, TransportFamily } from '@consensus/shared';

import { logger } from '../util/logger.js';
import { classify, describe } from './errors.js';
import { AdapterError, type HealthResult, type ModelAdapter, type SendOptions, type SendResult } from './types.js';

const log = logger('failover');

/**
 * A seat that can degrade rather than die.
 *
 * The same model is often reachable several ways: a ChatGPT seat might be the
 * browser relay, a CDP-attached window, and an API key. Those have very
 * different failure modes — the relay breaks when the provider ships a UI
 * change, the API breaks when the key runs out of credit — and they rarely
 * break at the same time.
 *
 * So a seat is a chain. When the primary transport fails in a way that
 * retrying cannot fix, the next one takes over mid-run and the panel keeps its
 * seat instead of shrinking. The switch is logged and surfaced, never silent:
 * the user needs to know an answer came from an API key rather than their
 * subscription, not least because it costs them differently.
 *
 * Failover is deliberately conservative. It does NOT trigger on:
 *   - `content_refused`, because a different transport to the same model will
 *     refuse the same prompt, and retrying it elsewhere is just quota burnt;
 *   - `aborted`, because the user meant it;
 *   - `non_compliant`, which is a model-behaviour problem, not a transport one.
 */
export class FailoverAdapter implements ModelAdapter {
  readonly kind: AdapterKind;
  readonly family: TransportFamily;

  private active = 0;
  private readonly exhausted = new Set<number>();

  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly chain: ModelAdapter[],
  ) {
    if (chain.length === 0) throw new Error(`seat "${id}" has no transports`);
    this.kind = chain[0]!.kind;
    this.family = chain[0]!.family;
  }

  /** The transports in this chain, for callers that need a specific one. */
  chainMembers(): ModelAdapter[] {
    return [...this.chain];
  }

  /** The transport currently in use, for the health strip. */
  get current(): ModelAdapter {
    return this.chain[this.active] ?? this.chain[0]!;
  }

  /**
   * Capabilities are the intersection across the chain: the orchestrator must
   * not be promised something a fallback cannot deliver after a switch.
   */
  get capabilities(): Capabilities {
    return this.chain.reduce<Capabilities>(
      (acc, adapter) => ({
        streaming: acc.streaming && adapter.capabilities.streaming,
        rawCopy: acc.rawCopy && adapter.capabilities.rawCopy,
        newThread: acc.newThread && adapter.capabilities.newThread,
        concurrent: acc.concurrent && adapter.capabilities.concurrent,
        systemPrompt: acc.systemPrompt && adapter.capabilities.systemPrompt,
        temperature: acc.temperature && adapter.capabilities.temperature,
        attachments: acc.attachments && adapter.capabilities.attachments,
        quotaVisible: acc.quotaVisible && adapter.capabilities.quotaVisible,
      }),
      { ...this.chain[0]!.capabilities },
    );
  }

  async health(): Promise<HealthResult> {
    const result = await this.current.health();
    if (result.ok || this.chain.length === 1) return result;

    // Report the chain honestly rather than the first link's failure alone.
    for (let i = this.active + 1; i < this.chain.length; i++) {
      const alt = await this.chain[i]!.health();
      if (alt.ok) {
        return {
          ok: true,
          detail: `${this.current.kind} is unavailable (${result.detail ?? 'unknown'}); ${this.chain[i]!.kind} is ready and will be used`,
        };
      }
    }
    return { ok: false, detail: `every transport for this seat is unavailable — last: ${result.detail ?? 'unknown'}` };
  }

  async send(prompt: string, opts: SendOptions): Promise<SendResult> {
    let lastError: unknown;

    for (let i = this.active; i < this.chain.length; i++) {
      if (this.exhausted.has(i)) continue;
      const adapter = this.chain[i]!;

      try {
        const result = await adapter.send(prompt, opts);
        if (i !== this.active) {
          log.info(`${this.id}: now served by ${adapter.kind}`);
          this.active = i;
        }
        return { ...result, via: result.via ?? adapter.kind };
      } catch (err) {
        lastError = err;
        const policy = classify(err);

        if (!policy.failover) throw err;

        // Mark this link unusable for the rest of the run only when retrying it
        // is pointless; a transient network blip should not burn the transport.
        if (policy.terminal) this.exhausted.add(i);

        const next = this.chain[i + 1];
        if (!next) break;

        log.warn(
          `${this.id}: ${adapter.kind} failed — ${describe(policy)} Falling over to ${next.kind}.`,
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new AdapterError('unknown', `every transport for seat "${this.id}" failed`);
  }

  async conformance(): Promise<ConformanceResult> {
    const at = Date.now();
    const checks: ConformanceResult['checks'] = [];

    for (const adapter of this.chain) {
      if (adapter.conformance) {
        const result = await adapter.conformance();
        checks.push(
          ...result.checks.map((c) => ({ ...c, name: `${adapter.kind}: ${c.name}` })),
        );
      } else {
        const health = await adapter.health();
        checks.push({ name: `${adapter.kind}: reachable`, ok: health.ok, detail: health.detail });
      }
    }

    // The chain is healthy if any link is: that is the point of having one.
    const perAdapter = new Map<string, boolean>();
    for (const c of checks) {
      const key = c.name.split(':')[0] ?? '';
      perAdapter.set(key, (perAdapter.get(key) ?? true) && c.ok);
    }
    return { ok: [...perAdapter.values()].some(Boolean), at, checks };
  }

  async dispose(): Promise<void> {
    await Promise.all(this.chain.map((a) => a.dispose?.()));
  }
}
