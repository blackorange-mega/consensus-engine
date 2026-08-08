import { AdapterError, reasonForStatus } from './types.js';

/** Shared HTTP plumbing for the API and local-model adapters. */

export interface JsonPostOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}

function linkSignals(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onOuter = () => controller.abort(new Error('aborted'));
  outer?.addEventListener('abort', onOuter, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    },
  };
}

export async function postJson<T = unknown>(opts: JsonPostOptions): Promise<T> {
  const { signal, done } = linkSignals(opts.timeoutMs, opts.signal);
  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(opts.body),
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new AdapterError(
        reasonForStatus(res.status, text),
        `${res.status} ${res.statusText}`,
        text.slice(0, 500),
      );
    }
    return JSON.parse(text) as T;
  } catch (err) {
    throw wrapFetchError(err);
  } finally {
    done();
  }
}

export async function getJson<T = unknown>(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<T> {
  const { signal, done } = linkSignals(timeoutMs);
  try {
    const res = await fetch(url, { headers, signal });
    const text = await res.text();
    if (!res.ok) {
      throw new AdapterError(reasonForStatus(res.status, text), `${res.status} ${res.statusText}`);
    }
    return JSON.parse(text) as T;
  } catch (err) {
    throw wrapFetchError(err);
  } finally {
    done();
  }
}

/**
 * Stream a response body line by line.
 * `onLine` gets raw lines; the caller decodes SSE or NDJSON as appropriate.
 */
export async function postStream(
  opts: JsonPostOptions,
  onLine: (line: string) => void,
): Promise<Record<string, string>> {
  const { signal, done } = linkSignals(opts.timeoutMs, opts.signal);
  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(opts.body),
      signal,
    });
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text() : '';
      throw new AdapterError(
        reasonForStatus(res.status, text),
        `${res.status} ${res.statusText}`,
        text.slice(0, 500),
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length) onLine(line.replace(/\r$/, ''));
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length) onLine(buffer.trim());

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k.startsWith('x-ratelimit') || k === 'retry-after' || k.startsWith('anthropic-ratelimit')) {
        headers[k] = v;
      }
    });
    return headers;
  } catch (err) {
    throw wrapFetchError(err);
  } finally {
    done();
  }
}

function wrapFetchError(err: unknown): AdapterError {
  if (err instanceof AdapterError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(message)) {
    return new AdapterError(/timeout/i.test(message) ? 'timeout' : 'aborted', message);
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN|network/i.test(message)) {
    return new AdapterError('network', message);
  }
  return new AdapterError('unknown', message);
}

/** Summarise rate-limit headers into a one-line quota hint for the health strip. */
export function quotaHintFrom(headers: Record<string, string>): string | undefined {
  const remaining =
    headers['x-ratelimit-remaining-requests'] ??
    headers['anthropic-ratelimit-requests-remaining'] ??
    headers['x-ratelimit-remaining'];
  const reset =
    headers['x-ratelimit-reset-requests'] ?? headers['anthropic-ratelimit-requests-reset'] ?? headers['retry-after'];
  if (!remaining) return undefined;
  return reset ? `${remaining} requests left (resets ${reset})` : `${remaining} requests left`;
}
