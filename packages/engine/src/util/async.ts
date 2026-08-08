/** Small async helpers: deadlines, backoff, and bounded concurrency. */

export class TimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export class AbortedError extends Error {
  constructor(reason = 'aborted') {
    super(reason);
    this.name = 'AbortedError';
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Hard deadline around a promise. Every model call gets one --
 * a hung provider tab must never wedge the whole run.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new TimeoutError(ms));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Randomised delay inside a window. Used for human-plausible send pacing. */
export function jitter([lo, hi]: [number, number]): number {
  return Math.floor(lo + Math.random() * Math.max(0, hi - lo));
}

export interface BackoffOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  signal?: AbortSignal;
  /** Return false to stop retrying immediately (e.g. a usage cap). */
  retryable?: (err: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof AbortedError) throw err;
      if (opts.retryable && !opts.retryable(err)) throw err;
      if (attempt === opts.attempts) break;
      const delay = Math.min(opts.maxMs, opts.baseMs * 2 ** (attempt - 1));
      const withJitter = Math.floor(delay * (0.5 + Math.random() * 0.5));
      opts.onRetry?.(attempt, withJitter, err);
      await sleep(withJitter, opts.signal);
    }
  }
  throw lastErr;
}

/**
 * Run tasks with a concurrency cap. Never rejects: a failing task resolves to
 * its error so one dead seat cannot take down the round.
 */
export async function pool<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  const results = new Array<{ ok: true; value: T } | { ok: false; error: unknown }>(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= tasks.length) return;
      const task = tasks[i];
      if (!task) return;
      try {
        results[i] = { ok: true, value: await task() };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/** A mutex. The clipboard is a single global resource; parallel seats must not race for it. */
export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}
