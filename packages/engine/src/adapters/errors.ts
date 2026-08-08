import type { SeatFailureReason } from '@consensus/shared';

import { AdapterError } from './types.js';

/**
 * Error intelligence.
 *
 * A transport failure is not one thing. "429" from OpenAI because you sent
 * three requests in a second is a two-second wait; "429" because your credit
 * balance is zero is terminal and no amount of backoff will fix it. Treating
 * them the same either wastes the run or hammers a provider that has already
 * said no.
 *
 * So every failure is resolved to a policy: is it worth retrying, how long
 * should we wait (preferring what the provider actually told us over our own
 * guess), should we give up on this transport and fail over to another, and —
 * the part that usually gets skipped — what can the user actually do about it.
 */

export interface ErrorPolicy {
  reason: SeatFailureReason;
  /** Worth trying again on this same transport. */
  retryable: boolean;
  /** Provider-supplied wait, from Retry-After or an error body. Beats our backoff. */
  retryAfterMs?: number;
  /** Retrying cannot help; drop the seat now rather than burning the round. */
  terminal: boolean;
  /** Try this seat's fallback transport instead, if it has one configured. */
  failover: boolean;
  /** Plain-English next step, surfaced in the transport health strip. */
  remediation: string;
}

const POLICIES: Record<SeatFailureReason, Omit<ErrorPolicy, 'reason' | 'retryAfterMs'>> = {
  rate_limited: {
    retryable: true,
    terminal: false,
    failover: true,
    remediation: 'Too many requests in a short window. The run will back off and continue.',
  },
  usage_cap: {
    retryable: false,
    terminal: true,
    failover: true,
    remediation:
      'This account has hit its usage cap. The seat leaves the panel and the run continues without it. ' +
      'Add a local model to absorb the extra rounds.',
  },
  content_refused: {
    retryable: false,
    terminal: false,
    failover: false,
    remediation:
      'The provider declined to answer this prompt. Other seats continue; the panel shrinks by one for this question.',
  },
  network: {
    retryable: true,
    terminal: false,
    failover: true,
    remediation: 'Could not reach the provider. Check connectivity; the run will retry with backoff.',
  },
  login_expired: {
    retryable: false,
    terminal: true,
    failover: true,
    remediation: 'The session is no longer authenticated. Sign in to that provider in your browser, then re-test the seat.',
  },
  challenge: {
    retryable: false,
    terminal: true,
    failover: true,
    remediation:
      'The provider is showing a bot check. Open that tab and clear it yourself — this app will not attempt to bypass it.',
  },
  timeout: {
    retryable: true,
    terminal: false,
    failover: true,
    remediation: 'The provider did not finish in time. Raise the per-call timeout if this recurs.',
  },
  non_compliant: {
    retryable: true,
    terminal: false,
    failover: false,
    remediation:
      'The model broke the required output format twice. It is excluded from this round only and may comply next round.',
  },
  budget_exhausted: {
    retryable: false,
    terminal: true,
    failover: true,
    remediation: 'This seat used its message budget for the run. Raise the budget or add another seat.',
  },
  not_configured: {
    retryable: false,
    terminal: true,
    failover: true,
    remediation: 'The seat is not usable as configured. Check its settings in the Transport tab.',
  },
  aborted: {
    retryable: false,
    terminal: true,
    failover: false,
    remediation: 'Stopped by you or by the kill switch.',
  },
  unknown: {
    retryable: true,
    terminal: false,
    failover: true,
    remediation: 'An unclassified failure. The activity log has the raw detail.',
  },
};

/** `Retry-After` is either delta-seconds or an HTTP date. Both appear in the wild. */
export function parseRetryAfter(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10 * 60_000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 10 * 60_000));
  return undefined;
}

/**
 * Provider error bodies disagree about everything except that they are JSON.
 * This pulls the distinctions that actually change our behaviour out of each.
 */
export function refineFromBody(reason: SeatFailureReason, body: string | undefined): SeatFailureReason {
  if (!body) return reason;
  const lower = body.toLowerCase();

  // Quota vs rate limit — the single most consequential distinction, because
  // one is a two-second wait and the other ends the seat's participation.
  if (reason === 'rate_limited' || reason === 'unknown') {
    if (/insufficient_quota|billing|credit balance|exceeded your current quota|payment required/.test(lower)) {
      return 'usage_cap';
    }
  }

  // Anthropic returns overloaded_error under a 429/529 — transient, not a cap.
  if (/overloaded_error|"type"\s*:\s*"overloaded"/.test(lower)) return 'rate_limited';

  // Google's RESOURCE_EXHAUSTED covers both; the message disambiguates.
  if (/resource_exhausted/.test(lower)) {
    return /quota|billing/.test(lower) ? 'usage_cap' : 'rate_limited';
  }

  if (/invalid_api_key|authentication_error|unauthorized|invalid x-api-key/.test(lower)) return 'login_expired';
  if (/context_length_exceeded|maximum context length|too many tokens|prompt is too long/.test(lower)) {
    return 'content_refused';
  }
  if (/content_policy|safety|blocked|refus/.test(lower) && reason !== 'usage_cap') return 'content_refused';

  return reason;
}

export interface ClassifyContext {
  /** Consecutive failures already seen for this seat. */
  attempt?: number;
  /** Raw response headers, when the transport has them. */
  headers?: Record<string, string>;
}

export function classify(err: unknown, ctx: ClassifyContext = {}): ErrorPolicy {
  let reason: SeatFailureReason = 'unknown';
  let detail: string | undefined;

  if (err instanceof AdapterError) {
    reason = err.reason;
    detail = err.detail ?? err.message;
  } else if (err instanceof Error) {
    detail = err.message;
    if (/abort/i.test(err.message)) reason = 'aborted';
    else if (/timeout|timed out/i.test(err.message)) reason = 'timeout';
    else if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(err.message)) reason = 'network';
  }

  reason = refineFromBody(reason, detail);

  const base = POLICIES[reason] ?? POLICIES.unknown;
  const retryAfterMs =
    parseRetryAfter(ctx.headers?.['retry-after']) ??
    parseRetryAfter(ctx.headers?.['x-ratelimit-reset-requests']) ??
    undefined;

  return { reason, retryAfterMs, ...base };
}

/** How long to wait before the next attempt, preferring the provider's own number. */
export function backoffFor(policy: ErrorPolicy, attempt: number, baseMs = 1_000, maxMs = 60_000): number {
  if (policy.retryAfterMs !== undefined) return policy.retryAfterMs;
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  // Full jitter: several seats failing together must not retry in lockstep and
  // re-trip the same limit.
  return Math.floor(exponential * (0.5 + Math.random() * 0.5));
}

/** One-line summary for the activity log and the health strip. */
export function describe(policy: ErrorPolicy, detail?: string): string {
  const wait = policy.retryAfterMs !== undefined ? ` (provider asked for ${Math.round(policy.retryAfterMs / 1000)}s)` : '';
  const disposition = policy.terminal ? 'seat dropped' : policy.retryable ? 'will retry' : 'skipped this round';
  return `${policy.reason}${wait} — ${disposition}. ${policy.remediation}${detail ? ` [${detail.slice(0, 160)}]` : ''}`;
}
