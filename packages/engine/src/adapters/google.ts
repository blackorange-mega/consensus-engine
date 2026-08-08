import type { AdapterKind, Capabilities, TransportFamily } from '@consensus/shared';

import { postJson } from './http.js';
import { AdapterError, DEFAULT_CAPABILITIES, type ModelAdapter, type SendOptions, type SendResult } from './types.js';

export interface GoogleOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  pricing?: { inPerM?: number; outPerM?: number };
}

interface GenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

export class GoogleAdapter implements ModelAdapter {
  readonly kind: AdapterKind = 'google';
  readonly family: TransportFamily = 'api';
  readonly capabilities: Capabilities = { ...DEFAULT_CAPABILITIES, streaming: false };

  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly opts: GoogleOptions,
  ) {}

  private get base() {
    return this.opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
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
    const res = await postJson<GenerateResponse>({
      url: `${this.base}/models/${this.opts.model}:generateContent?key=${encodeURIComponent(this.opts.apiKey)}`,
      headers: {},
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      body: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        ...(opts.systemPrompt
          ? { systemInstruction: { parts: [{ text: opts.systemPrompt }] } }
          : {}),
        generationConfig: { temperature: opts.temperature ?? this.opts.temperature ?? 0 },
      },
    });

    if (res.promptFeedback?.blockReason) {
      throw new AdapterError('content_refused', `blocked: ${res.promptFeedback.blockReason}`);
    }

    const text = (res.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    if (!text) throw new AdapterError('content_refused', 'empty completion');

    const inTokens = res.usageMetadata?.promptTokenCount;
    const outTokens = res.usageMetadata?.candidatesTokenCount;
    const result: SendResult = { text, via: 'api', tokens: { in: inTokens, out: outTokens } };
    const price = this.opts.pricing;
    if (price) {
      result.costUsd =
        ((inTokens ?? 0) / 1e6) * (price.inPerM ?? 0) + ((outTokens ?? 0) / 1e6) * (price.outPerM ?? 0);
    }
    return result;
  }
}
