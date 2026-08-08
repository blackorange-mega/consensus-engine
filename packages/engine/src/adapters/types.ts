import type {
  AdapterKind,
  Capabilities,
  ConformanceResult,
  SeatFailureReason,
  TransportFamily,
} from '@consensus/shared';

/**
 * The transport interface every seat implements:
 * `ModelAdapter { id, displayName, capabilities, send(...), health() }`.
 *
 * All five transport families are first-class. The orchestrator does not know
 * or care which one is behind a given panel seat, so a single run routinely
 * mixes them: Claude over CLI, ChatGPT over the browser relay, a local Qwen
 * over Ollama.
 */

export interface SendOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Force a fresh conversation. Ignored by adapters without `newThread`. */
  newThread?: boolean;
  systemPrompt?: string;
  temperature?: number;
  /** Live token callback, when the adapter declares `streaming`. */
  onDelta?: (text: string) => void;
}

export interface SendResult {
  /** Byte-exact model output. Never normalised, re-wrapped or spell-corrected. */
  text: string;
  /** True when extraction had to fall back to a lossy path. */
  lossy?: boolean;
  via?: string;
  tokens?: { in?: number; out?: number };
  costUsd?: number;
  /** Anything the transport can tell us about remaining quota. */
  quotaHint?: string;
}

export interface HealthResult {
  ok: boolean;
  detail?: string;
  quotaHint?: string;
}

export interface ModelAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly kind: AdapterKind;
  readonly family: TransportFamily;
  readonly capabilities: Capabilities;
  send(prompt: string, opts: SendOptions): Promise<SendResult>;
  health(): Promise<HealthResult>;
  /** Conformance smoke test. UI-driven seats must implement this. */
  conformance?(): Promise<ConformanceResult>;
  dispose?(): Promise<void>;
}

/** Every adapter failure is classified; "it just didn't answer" is not a reason (5.3A). */
export class AdapterError extends Error {
  constructor(
    public readonly reason: SeatFailureReason,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export const DEFAULT_CAPABILITIES: Capabilities = {
  streaming: false,
  rawCopy: true,
  newThread: true,
  concurrent: true,
  systemPrompt: true,
  temperature: true,
  attachments: false,
  quotaVisible: false,
};

/** Map an HTTP status onto a failure reason the circuit breaker understands. */
export function reasonForStatus(status: number, body: string): SeatFailureReason {
  const lower = body.toLowerCase();
  if (status === 401) return 'login_expired';
  if (status === 403) return lower.includes('quota') ? 'usage_cap' : 'login_expired';
  if (status === 429) {
    return /quota|credit|billing|insufficient|exceeded your current/.test(lower)
      ? 'usage_cap'
      : 'rate_limited';
  }
  if (status === 400 && /content|safety|policy|refus/.test(lower)) return 'content_refused';
  if (status >= 500) return 'network';
  return 'unknown';
}

export function isRetryable(reason: SeatFailureReason): boolean {
  return reason === 'rate_limited' || reason === 'network' || reason === 'timeout';
}
