import type { AdapterKind, Capabilities, TransportFamily } from '@consensus/shared';
import { FAMILY_OF } from '@consensus/shared';

import { logger } from '../util/logger.js';
import { getJson, postStream, quotaHintFrom } from './http.js';
import { AdapterError, DEFAULT_CAPABILITIES, type ModelAdapter, type SendOptions, type SendResult } from './types.js';

const log = logger('adapter:openai');

/**
 * Does this error look like the endpoint rejecting a parameter it does not know
 * about, rather than a real problem with the request?
 */
function isUnsupportedParam(err: unknown): boolean {
  if (!(err instanceof AdapterError)) return false;
  const blob = `${err.message} ${err.detail ?? ''}`.toLowerCase();
  if (!/^4\d\d|400|422/.test(err.message) && !blob.includes('400') && !blob.includes('422')) {
    // Some servers report it as a plain unknown failure.
    if (err.reason !== 'unknown' && err.reason !== 'content_refused') return false;
  }
  return /stream_options|include_usage|unrecognized|unknown (?:field|parameter|argument)|unexpected keyword|extra fields not permitted|does not support/.test(
    blob,
  );
}

/**
 * Any OpenAI-shaped `/chat/completions` endpoint: OpenAI, OpenRouter, LM Studio,
 * vLLM, llama.cpp's server, and most local runtimes. One adapter covers the
 * whole family because they all speak the same wire format.
 */
export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Sent as `HTTP-Referer`/`X-Title` by OpenRouter convention. */
  appName?: string;
  temperature?: number;
  maxTokens?: number;
  /** Cost per million tokens, for the run report. */
  pricing?: { inPerM?: number; outPerM?: number };
}

export class OpenAiCompatibleAdapter implements ModelAdapter {
  readonly family: TransportFamily;
  /** Cleared permanently the first time the endpoint rejects the parameter. */
  private supportsStreamOptions = true;
  readonly capabilities: Capabilities = {
    ...DEFAULT_CAPABILITIES,
    streaming: true,
    rawCopy: true,
    newThread: true,
    concurrent: true,
    quotaVisible: true,
  };

  constructor(
    readonly id: string,
    readonly displayName: string,
    readonly kind: AdapterKind,
    private readonly opts: OpenAiCompatibleOptions,
  ) {
    this.family = FAMILY_OF[kind];
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.opts.apiKey) h.authorization = `Bearer ${this.opts.apiKey}`;
    if (this.opts.appName) {
      h['http-referer'] = 'http://127.0.0.1';
      h['x-title'] = this.opts.appName;
    }
    return h;
  }

  async health() {
    try {
      const res = await getJson<{ data?: Array<{ id: string }> }>(
        `${this.opts.baseUrl}/models`,
        this.headers(),
        8_000,
      );
      const models = res.data?.map((m) => m.id) ?? [];
      const present = models.length === 0 || models.includes(this.opts.model);
      return {
        ok: present,
        detail: present ? `${this.opts.model} reachable` : `model ${this.opts.model} not listed by the endpoint`,
      };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async send(prompt: string, opts: SendOptions): Promise<SendResult> {
    try {
      return await this.attempt(prompt, opts);
    } catch (err) {
      // `stream_options` is an OpenAI extension that several OpenAI-compatible
      // servers reject outright (LM Studio, older vLLM and llama.cpp builds all
      // have open issues about it). Losing token counts is a far better outcome
      // than losing the answer, so drop it once and retry.
      if (this.supportsStreamOptions && isUnsupportedParam(err)) {
        this.supportsStreamOptions = false;
        log.info(
          `${this.id}: endpoint rejected stream_options; retrying without it — token counts will be unavailable`,
        );
        return await this.attempt(prompt, opts);
      }
      throw err;
    }
  }

  private async attempt(prompt: string, opts: SendOptions): Promise<SendResult> {
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.systemPrompt && this.capabilities.systemPrompt) {
      messages.push({ role: 'system', content: opts.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    let text = '';
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

    const headers = await postStream(
      {
        url: `${this.opts.baseUrl}/chat/completions`,
        headers: this.headers(),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        body: {
          model: this.opts.model,
          messages,
          stream: true,
          ...(this.supportsStreamOptions ? { stream_options: { include_usage: true } } : {}),
          temperature: opts.temperature ?? this.opts.temperature ?? 0,
          ...(this.opts.maxTokens ? { max_tokens: this.opts.maxTokens } : {}),
        },
      },
      (line) => {
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            opts.onDelta?.(delta);
          }
        } catch {
          /* keep-alive comments and partial frames are expected */
        }
      },
    );

    if (!text) throw new AdapterError('content_refused', 'the endpoint returned an empty completion');

    const result: SendResult = { text, via: 'api' };
    if (usage) {
      result.tokens = { in: usage.prompt_tokens, out: usage.completion_tokens };
      const price = this.opts.pricing;
      if (price) {
        result.costUsd =
          ((usage.prompt_tokens ?? 0) / 1e6) * (price.inPerM ?? 0) +
          ((usage.completion_tokens ?? 0) / 1e6) * (price.outPerM ?? 0);
      }
    }
    const hint = quotaHintFrom(headers);
    if (hint) result.quotaHint = hint;
    return result;
  }
}
