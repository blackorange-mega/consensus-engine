import type { AdapterKind, Capabilities, TransportFamily } from '@consensus/shared';

import { postStream, quotaHintFrom } from './http.js';
import { AdapterError, DEFAULT_CAPABILITIES, type ModelAdapter, type SendOptions, type SendResult } from './types.js';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  pricing?: { inPerM?: number; outPerM?: number };
}

export class AnthropicAdapter implements ModelAdapter {
  readonly kind: AdapterKind = 'anthropic';
  readonly family: TransportFamily = 'api';
  readonly capabilities: Capabilities = {
    ...DEFAULT_CAPABILITIES,
    streaming: true,
    quotaVisible: true,
  };

  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly opts: AnthropicOptions,
  ) {}

  private get base() {
    return this.opts.baseUrl ?? 'https://api.anthropic.com';
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.opts.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  async health() {
    if (!this.opts.apiKey) return { ok: false, detail: 'no API key configured' };
    try {
      await this.send('Reply with the single character: 1', { timeoutMs: 15_000 });
      return { ok: true, detail: `${this.opts.model} reachable` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async send(prompt: string, opts: SendOptions): Promise<SendResult> {
    let text = '';
    let inTokens: number | undefined;
    let outTokens: number | undefined;

    const headers = await postStream(
      {
        url: `${this.base}/v1/messages`,
        headers: this.headers(),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        body: {
          model: this.opts.model,
          max_tokens: this.opts.maxTokens ?? 8192,
          temperature: opts.temperature ?? this.opts.temperature ?? 0,
          stream: true,
          ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
          messages: [{ role: 'user', content: prompt }],
        },
      },
      (line) => {
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
          const evt = JSON.parse(payload) as {
            type?: string;
            delta?: { text?: string };
            message?: { usage?: { input_tokens?: number; output_tokens?: number } };
            usage?: { output_tokens?: number };
            error?: { message?: string };
          };
          if (evt.type === 'error') throw new AdapterError('unknown', evt.error?.message ?? 'stream error');
          if (evt.type === 'content_block_delta' && evt.delta?.text) {
            text += evt.delta.text;
            opts.onDelta?.(evt.delta.text);
          }
          if (evt.type === 'message_start') inTokens = evt.message?.usage?.input_tokens;
          if (evt.type === 'message_delta') outTokens = evt.usage?.output_tokens;
        } catch (err) {
          if (err instanceof AdapterError) throw err;
        }
      },
    );

    if (!text) throw new AdapterError('content_refused', 'empty completion');

    const result: SendResult = { text, via: 'api', tokens: { in: inTokens, out: outTokens } };
    const price = this.opts.pricing;
    if (price) {
      result.costUsd =
        ((inTokens ?? 0) / 1e6) * (price.inPerM ?? 0) + ((outTokens ?? 0) / 1e6) * (price.outPerM ?? 0);
    }
    const hint = quotaHintFrom(headers);
    if (hint) result.quotaHint = hint;
    return result;
  }
}
