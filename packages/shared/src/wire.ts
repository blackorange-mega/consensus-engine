/**
 * Wire protocol.
 *
 * Two channels, deliberately separate:
 *   /ws     engine -> UI       run telemetry (this file, `EngineEvent`)
 *   /relay  engine <-> browser extension  a fixed, enumerable action set
 *
 * The relay action set is a closed union on purpose: there must
 * be no path from a model's output to an executed browser action, so the
 * extension only ever accepts these shapes and only for registered origins.
 */

import type {
  AuditEntry,
  ConsensusReport,
  RunOutcome,
  RunRecord,
  RunStatus,
  SeatFailureReason,
  SeatHealth,
  SeatTurn,
  TaskClassification,
} from './types.js';

/* ------------------------------------------------------- engine -> UI */

export type EngineEvent =
  | { type: 'hello'; engineVersion: string; killSwitch: boolean }
  | { type: 'run:created'; run: RunRecord }
  | { type: 'run:status'; runId: string; status: RunStatus; outcome?: RunOutcome | null }
  | { type: 'run:classified'; runId: string; classification: TaskClassification }
  | { type: 'round:start'; runId: string; round: number; letters: Record<string, string> }
  | { type: 'round:end'; runId: string; round: number; consensus: ConsensusReport | null }
  | { type: 'turn:start'; runId: string; round: number; seatId: string; kind: string; prompt: string }
  | { type: 'turn:delta'; runId: string; seatId: string; turnId: string; delta: string }
  | { type: 'turn:end'; runId: string; turn: SeatTurn }
  | {
      type: 'seat:status';
      runId?: string;
      seatId: string;
      status: 'healthy' | 'degraded' | 'dropped';
      reason?: SeatFailureReason;
      detail?: string;
    }
  | { type: 'seat:health'; health: SeatHealth[] }
  | { type: 'run:awaiting'; runId: string; round: number; prompts: Record<string, string> }
  | { type: 'run:done'; run: RunRecord }
  | { type: 'audit'; entry: AuditEntry }
  | { type: 'killswitch'; engaged: boolean; by: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; at: number };

/* --------------------------------------------- engine <-> relay extension */

/** The complete, fixed action set the relay extension will execute. */
export type RelayAction =
  /** Confirm the tab is on a registered origin and the descriptor matches. */
  | { kind: 'probe'; provider: string }
  /** Open or focus the seat's dedicated tab, kept warm across rounds. */
  | { kind: 'ensureTab'; provider: string; url: string }
  /** Start a new conversation in the seat's tab. */
  | { kind: 'newThread'; provider: string }
  /**
   * Deliver an exact string. The extension pastes via clipboard, reads the
   * composer back, and refuses to submit unless it matches byte-for-byte.
   */
  | { kind: 'send'; provider: string; text: string; verifyEcho: boolean }
  /** Wait for the composite completion signal, then extract the answer. */
  | { kind: 'awaitAndExtract'; provider: string; timeoutMs: number }
  /** Byte-exact round trip check used by the conformance suite. */
  | { kind: 'conformance'; provider: string; fixture: string; expect?: string }
  /**
   * Re-discover selectors for a provider whose descriptor has gone stale.
   * Returns candidates only — it never applies them. The engine validates a
   * repair against a smoke test before anything is cached.
   */
  | { kind: 'heal'; provider: string }
  /** Stop everything now. */
  | { kind: 'abort'; provider?: string };

export type RelayRequest = {
  type: 'action';
  id: string;
  seatId: string;
  action: RelayAction;
};

/**
 * How a piece of text was recovered from a page.
 *
 * `copy_event` is the good path: the provider's own copy button is clicked and
 * the write is intercepted in the page, which yields source markdown, works in
 * an unfocused background tab, and never touches the user's real clipboard.
 * `inner_text` is the lossy fallback and is surfaced as such in the UI.
 */
export type ExtractionPath = 'copy_event' | 'json_endpoint' | 'inner_text';

export type RelayResponse =
  | { type: 'ready'; extensionVersion: string; browser: string; descriptorPackVersion: string }
  | { type: 'ack'; id: string }
  | { type: 'delta'; id: string; text: string }
  /** Application-level keepalive, so a zombie socket is detected in ~20s. */
  | { type: 'ping'; at: number }
  | { type: 'pong'; at: number }
  | {
      type: 'result';
      id: string;
      ok: true;
      /** Byte-exact source text, ideally from the provider's own copy button. */
      text: string;
      /** True when we had to fall back to a de-rendered DOM read. */
      lossy: boolean;
      /** Which extraction path actually produced the text. */
      via: ExtractionPath;
      meta?: Record<string, unknown>;
    }
  | {
      type: 'result';
      id: string;
      ok: false;
      reason: SeatFailureReason;
      detail?: string;
    }
  | { type: 'audit'; seatId: string; action: string; target?: string; detail?: string; ok: boolean }
  | { type: 'tabs'; tabs: Array<{ provider: string; tabId: number; url: string; loggedIn: boolean }> };

export type RelayServerMessage =
  | RelayRequest
  | { type: 'hello'; token: string; descriptorPack: unknown }
  | { type: 'killswitch'; engaged: boolean };

/* ------------------------------------------------------------ UI -> engine */

export type RunControl =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'step' }
  | { kind: 'abort' }
  /** Manual mode: approve the generated prompts, optionally edited first. */
  | { kind: 'approve'; edited?: Record<string, string> }
  /** Human judge, or overriding the installed judge's equivalence call. */
  | { kind: 'verdict'; equivalent: boolean; note?: string }
  /** Drop a seat by hand mid-run. */
  | { kind: 'dropSeat'; seatId: string; reason?: string };
