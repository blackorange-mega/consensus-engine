import type { AdapterKind, Capabilities, TransportFamily } from '@consensus/shared';

import { getJson, postStream } from './http.js';
import { AdapterError, DEFAULT_CAPABILITIES, type ModelAdapter, type SendOptions, type SendResult } from './types.js';

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  temperature?: number;
  /** Fixed seed, so a run can be reproduced exactly. */
  seed?: number;
  numCtx?: number;
}

/**
 * Ollama over localhost HTTP. Free, offline, unlimited — which makes local
 * seats the right place to spend the extra debate rounds: prefer unmetered
 * seats so the subscription seats survive the run.
 */
export class OllamaAdapter implements ModelAdapter {
  readonly kind: AdapterKind = 'ollama';
  readonly family: TransportFamily = 'local';
  readonly capabilities: Capabilities = {
    ...DEFAULT_CAPABILITIES,
    streaming: true,
    rawCopy: true,
    newThread: true,
    concurrent: true,
    temperature: true,
    quotaVisible: false,
  };

  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly opts: OllamaOptions,
  ) {}

  async health() {
    try {
      const res = await getJson<{ models?: Array<{ name: string }> }>(
        `${this.opts.baseUrl}/api/tags`,
        {},
        5_000,
      );
      const names = res.models?.map((m) => m.name) ?? [];
      const present = names.some((n) => n === this.opts.model || n.split(':')[0] === this.opts.model);
      return {
        ok: present,
        detail: present
          ? `${this.opts.model} available locally`
          : `model not pulled — run: ollama pull ${this.opts.model}`,
      };
    } catch (err) {
      return { ok: false, detail: `Ollama not reachable at ${this.opts.baseUrl}` };
    }
  }

  async send(prompt: string, opts: SendOptions): Promise<SendResult> {
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt });
    messages.push({ role: 'user', content: prompt });

    let text = '';
    let evalCount: number | undefined;
    let promptEvalCount: number | undefined;

    await postStream(
      {
        url: `${this.opts.baseUrl}/api/chat`,
        headers: {},
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        body: {
          model: this.opts.model,
          messages,
          stream: true,
          options: {
            temperature: opts.temperature ?? this.opts.temperature ?? 0,
            ...(this.opts.seed !== undefined ? { seed: this.opts.seed } : {}),
            ...(this.opts.numCtx ? { num_ctx: this.opts.numCtx } : {}),
          },
        },
      },
      (line) => {
        try {
          const chunk = JSON.parse(line) as {
            message?: { content?: string };
            done?: boolean;
            eval_count?: number;
            prompt_eval_count?: number;
            error?: string;
          };
          if (chunk.error) throw new AdapterError('unknown', chunk.error);
          const delta = chunk.message?.content;
          if (delta) {
            text += delta;
            opts.onDelta?.(delta);
          }
          if (chunk.done) {
            evalCount = chunk.eval_count;
            promptEvalCount = chunk.prompt_eval_count;
          }
        } catch (err) {
          if (err instanceof AdapterError) throw err;
        }
      },
    );

    if (!text) throw new AdapterError('unknown', 'Ollama returned an empty response');

    return {
      text,
      via: 'ollama',
      tokens: { in: promptEvalCount, out: evalCount },
      costUsd: 0,
    };
  }
}
