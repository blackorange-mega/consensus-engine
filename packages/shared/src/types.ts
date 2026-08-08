/**
 * Core domain types shared by the engine, the UI and the relay extension.
 *
 * Everything here is transport-agnostic on purpose: the orchestrator must not
 * know whether a panel seat is a CLI, a local model, an API key or a browser
 * tab being driven by the relay extension.
 */

/* ------------------------------------------------------------------ seats */

/** Concrete adapter implementations. */
export type AdapterKind =
  | 'mock'
  | 'cli'
  | 'ollama'
  | 'lmstudio'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'relay'
  /** Chrome DevTools Protocol: attach to a local browser, or drive a dedicated profile. */
  | 'cdp'
  | 'desktop';

/** The five co-equal transport families (+ `mock` for tests). */
export type TransportFamily = 'relay' | 'desktop' | 'cli' | 'local' | 'api' | 'mock';

export const FAMILY_OF: Record<AdapterKind, TransportFamily> = {
  mock: 'mock',
  cli: 'cli',
  ollama: 'local',
  lmstudio: 'local',
  openai: 'api',
  anthropic: 'api',
  google: 'api',
  openrouter: 'api',
  relay: 'relay',
  cdp: 'relay',
  desktop: 'desktop',
};

/** Declared per adapter so the orchestrator can degrade gracefully (4.7). */
export interface Capabilities {
  /** Can we show tokens live. */
  streaming: boolean;
  /** Can we obtain source markdown rather than rendered DOM (5.3B). */
  rawCopy: boolean;
  /** Can we force a fresh conversation per round. */
  newThread: boolean;
  /** Safe to run in parallel with other seats on the same provider account. */
  concurrent: boolean;
  systemPrompt: boolean;
  /** API/local only; UI-driven seats cannot set it. */
  temperature: boolean;
  attachments: boolean;
  quotaVisible: boolean;
}

export interface SeatBudget {
  /** Hard cap on messages this seat may receive within one run. */
  perRun?: number;
  /** Hard cap on messages this seat may receive within a rolling 24h window. */
  perDay?: number;
}

/**
 * A panel seat. `id` is the stable model identity used everywhere in the
 * protocol; expert letters are assigned per round and are never stable, which
 * is what defeats position bias.
 */
export interface SeatConfig {
  id: string;
  displayName: string;
  adapter: AdapterKind;
  enabled: boolean;
  /** The seat whose final answer is shown when the user wants one answer. */
  primary?: boolean;
  /** Adapter-specific settings (model name, base URL, command, origin, ...). */
  options: Record<string, unknown>;
  budget?: SeatBudget;
  /**
   * Alternative transports for the same model, tried in order when the primary
   * fails in a way retrying cannot fix.
   *
   * The same model is usually reachable several ways — browser relay, CDP
   * attach, API key — and those fail for unrelated reasons: a relay breaks when
   * the provider ships a UI change, a key breaks when it runs out of credit.
   * A seat with a chain degrades instead of leaving the panel.
   */
  fallbacks?: Array<{ adapter: AdapterKind; options: Record<string, unknown> }>;
}

export type SeatStatus = 'healthy' | 'degraded' | 'dropped';

/**
 * Every way a seat can fail. "It just didn't answer" is not good enough for
 * the run report, so failures are always classified.
 */
export type SeatFailureReason =
  | 'rate_limited'
  | 'usage_cap'
  | 'content_refused'
  | 'network'
  | 'login_expired'
  | 'challenge'
  | 'timeout'
  | 'non_compliant'
  | 'budget_exhausted'
  | 'not_configured'
  | 'aborted'
  | 'unknown';

export interface SeatHealth {
  seatId: string;
  status: SeatStatus;
  family: TransportFamily;
  adapter: AdapterKind;
  capabilities: Capabilities;
  /** Result of the per-seat conformance smoke test. */
  conformance: ConformanceResult | null;
  consecutiveFailures: number;
  lastFailure?: { reason: SeatFailureReason; detail?: string; at: number };
  /** Messages consumed, for the quota meter. */
  usage: { run: number; day: number };
  quotaHint?: string;
  /** Set when the seat's extraction path is known to be lossy (5.3B). */
  lossy?: boolean;
}

export interface ConformanceResult {
  ok: boolean;
  at: number;
  checks: Array<{
    name: string;
    ok: boolean;
    detail?: string;
    durationMs?: number;
  }>;
}

/* ------------------------------------------------------------- the verdict */

/**
 * The structured output contract. The prose `answer` is what a
 * human reads; `answer_key` is the bare claim that actually decides agreement.
 * Embeddings must never arbitrate this.
 */
export interface Verdict {
  agree: boolean;
  /** Always required alongside a verdict, even when agreeing. */
  answer?: string;
  /** Canonical bare claim: a number with units, a yes/no, a name, an id. */
  answer_key?: string;
  /** Expert letter -> null when that expert was correct, else why they are wrong. */
  critiques?: Record<string, string | null>;
  /** Self-reported 0..1. Advisory only; never used to fabricate consensus. */
  confidence?: number;
}

/** How the verdict was recovered, in the parser's preference order (4.1). */
export type ParseSource =
  | 'verdict_fence'
  | 'bare_json'
  | 'legacy_sentinel'
  | 'repaired'
  | 'malformed';

export interface ParseResult {
  source: ParseSource;
  verdict: Verdict | null;
  /** Non-fatal complaints worth showing the user. */
  warnings: string[];
}

/* ------------------------------------------------------------------- turns */

export type TurnKind =
  | 'dispatch'
  | 'judge'
  | 'revise'
  | 'rewrite'
  | 'repair'
  | 'classify'
  /** Self-consistency resample or cross-check review. */
  | 'verify';

/** One model call. The unit of everything: cost, latency, audit, replay. */
export interface SeatTurn {
  id: string;
  runId: string;
  round: number;
  seatId: string;
  kind: TurnKind;
  /** Expert letter this seat was given for this round (shuffled per round). */
  letter?: string;
  /** Content-hash of the exact prompt sent; the prompt itself is stored too. */
  promptHash: string;
  prompt: string;
  /** Raw model output, byte-exact, never normalised. */
  raw: string;
  verdict?: Verdict;
  parseSource?: ParseSource;
  /** Extracted prose answer after this turn. */
  answer?: string;
  answerKey?: string;
  /** Hash of the normalised answer key, for oscillation detection (4.3). */
  answerHash?: string;
  latencyMs: number;
  tokens?: { in?: number; out?: number };
  costUsd?: number;
  failure?: { reason: SeatFailureReason; detail?: string };
  /** True when extraction had to fall back to a de-rendered DOM read (5.3B). */
  lossy?: boolean;
  startedAt: number;
  finishedAt: number;
}

/* -------------------------------------------------------------------- runs */

export type RunMode = 'manual' | 'auto' | 'semi';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'done'
  | 'aborted'
  | 'error';

export type RunOutcome =
  /** Judge says equivalent and every surviving seat voted agree. */
  | 'converged'
  /** Seats all voted agree but the structured judge disagrees. Shown honestly. */
  | 'converged_contested'
  /** Never debated: task type is not verifiable, or a single seat ran. */
  | 'no_debate'
  | 'unresolved'
  | 'oscillating'
  | 'quorum_lost'
  | 'budget_exhausted'
  | 'timeout'
  | 'aborted'
  | 'error';

export type TaskType = 'factual' | 'computational' | 'code' | 'creative' | 'opinion';

export const DEBATABLE_TASK_TYPES: readonly TaskType[] = ['factual', 'computational', 'code'];

export interface TaskClassification {
  type: TaskType;
  confidence: number;
  rationale: string;
  source: 'heuristic' | 'llm' | 'user';
}

/**
 * The agreement-modulation dial. Smit et al. found tuning this
 * is what took a losing MAD protocol to SOTA, so it is a first-class,
 * user-adjustable, per-run-persisted, eval-swept setting -- not a constant.
 */
export type Stubbornness = 0 | 1 | 2 | 3 | 4;

export const STUBBORNNESS_LABELS: Record<Stubbornness, string> = {
  0: 'Concede readily',
  1: 'Open to persuasion',
  2: 'Balanced',
  3: 'Defend unless shown a concrete error',
  4: 'Defend unless proven wrong',
};

export type JudgeKind = 'structured' | 'embedding' | 'llm' | 'human';

export interface RunSettings {
  mode: RunMode;
  stubbornness: Stubbornness;
  judge: JudgeKind;
  maxRounds: number;
  /** Whole-run wall clock ceiling. */
  runTimeoutMs: number;
  /** Per model call ceiling. */
  callTimeoutMs: number;
  /** Semi mode: auto until this round, then hand over. */
  handoverRound?: number;
  /** Ask every model to restate the agreed answer once converged (2.5). */
  finalRewrite: boolean;
  /** Show only the primary seat's final answer instead of all of them. */
  showOnlyPrimary: boolean;
  /** Run the debate loop even for creative/opinion prompts (user override). */
  forceDebate: boolean;
  /** Per-seat message caps for this run. */
  perSeatRunBudget: number;
  /** Numeric tolerance used by the structured judge, relative. */
  numericTolerance: number;
  /**
   * Extra samples per seat used to check a model against itself. 0 disables it.
   * Costs one call per sample per seat, so it is off by default.
   */
  selfConsistencySamples: number;
  /** After convergence, have a seat that disagreed review the agreed answer. */
  crossCheck: boolean;
}

export const DEFAULT_RUN_SETTINGS: RunSettings = {
  mode: 'auto',
  stubbornness: 3,
  judge: 'structured',
  maxRounds: 4,
  runTimeoutMs: 15 * 60_000,
  callTimeoutMs: 180_000,
  finalRewrite: false,
  showOnlyPrimary: false,
  forceDebate: false,
  perSeatRunBudget: 12,
  numericTolerance: 1e-9,
  selfConsistencySamples: 0,
  crossCheck: false,
};

export interface RoundRecord {
  round: number;
  /** Letter assignment for this round; shuffled every round (2, note 1). */
  letters: Record<string, string>;
  /** seatId -> seatIds that still consider it wrong. Drives pruning (2.3). */
  critics: Record<string, string[]>;
  /** Hash of the normalised answer multiset, for oscillation detection. */
  stateHash: string;
  /** Panel-level equivalence decision from the installed Judge. */
  consensus: ConsensusReport | null;
  startedAt: number;
  finishedAt?: number;
}

/** Output of a Judge: are these answers the same claim, and if not, who is in which camp. */
export interface ConsensusReport {
  equivalent: boolean;
  judge: JudgeKind;
  /** One entry per distinct claim; seats grouped by the answer they hold. */
  camps: Array<{
    key: string;
    label: string;
    seatIds: string[];
    representativeAnswer: string;
  }>;
  /** Optional prose-similarity signal. Never decides equivalence on its own. */
  proseSpread?: number;
  detail?: string;
}

export interface RunRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  prompt: string;
  title: string;
  status: RunStatus;
  outcome: RunOutcome | null;
  settings: RunSettings;
  classification: TaskClassification | null;
  seatIds: string[];
  primarySeatId: string | null;
  rounds: RoundRecord[];
  /** Live per-seat view, including dropped seats and their frozen answers. */
  seats: Record<string, RunSeatState>;
  finalAnswer: string | null;
  finalAnswerKey: string | null;
  /** Snapshot of the templates used, so a run is replayable after edits. */
  templateSnapshot: Record<string, string>;
  /** Self-consistency, cross-check and calibrated confidence. */
  verification: VerificationReport | null;
  error?: string;
  stats: RunStats;
}

export interface RunSeatState {
  seatId: string;
  displayName: string;
  adapter: AdapterKind;
  family: TransportFamily;
  status: SeatStatus;
  /** Last known answer, retained and displayed even after a drop (3.2 item 3). */
  answer: string | null;
  answerKey: string | null;
  /** How many times this seat changed its answer. Capitulation signal (4.2). */
  flips: number;
  /** Rounds in which this seat voted agree. */
  agreedRounds: number[];
  droppedAtRound?: number;
  dropReason?: SeatFailureReason;
  messagesUsed: number;
  lossy?: boolean;
}

export interface RunStats {
  calls: number;
  failedCalls: number;
  rounds: number;
  wallMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Per-seat message consumption, for the quota meter. */
  messagesPerSeat: Record<string, number>;
}


/* ------------------------------------------------------ verification layer */

/** How reliably a seat reproduces its own answer when resampled. */
export interface SeatReliability {
  seatId: string;
  samples: string[];
  agreementRate: number;
  selfConsistent: boolean;
  modalKey: string;
}

/** A seat outside the winning camp reviewing the agreed answer. */
export interface CrossCheckResult {
  verifierSeatId: string;
  wasDissenter: boolean;
  agrees: boolean;
  objection?: string;
}

export interface ConfidenceFactor {
  name: string;
  contribution: number;
  detail: string;
}

/**
 * The output of the verification layer. Confidence is never shown without its
 * factors -- a bare percentage the user has to take on trust is worse than no
 * number at all.
 */
export interface VerificationReport {
  perSeat: SeatReliability[];
  crossCheck?: CrossCheckResult;
  confidence: number;
  band: 'low' | 'moderate' | 'high';
  factors: ConfidenceFactor[];
  summary: string;
}

/* ------------------------------------------------------- pre-flight budget */

/** Shown before a run starts: "this will use ~5 messages from each of 4 seats." */
export interface PreflightEstimate {
  seats: number;
  rounds: number;
  worstCaseCalls: number;
  expectedCalls: number;
  messagesPerSeat: number;
  serialSteps: number;
  estimatedMinutes: [number, number];
  perSeat: Array<{
    seatId: string;
    displayName: string;
    messages: number;
    remainingToday: number | null;
    willExhaust: boolean;
  }>;
  warnings: string[];
}

/* ------------------------------------------------------------- scoreboard */

/** Lifetime per-model accuracy, built from the user's own questions (3.2.5). */
export interface ScoreboardEntry {
  seatId: string;
  displayName: string;
  runs: number;
  /** Round-1 answer matched the converged answer. */
  correctFirst: number;
  /** Round-1 answer differed from the converged answer. */
  overruled: number;
  /** Convinced at least one other seat to change its answer. */
  persuaded: number;
  /** Changed its own answer. */
  flips: number;
  /** Right in round 1, wrong at convergence. The sycophancy counter (4.2). */
  talkedOutOfCorrect: number;
  withdrawals: number;
  nonCompliant: number;
  avgLatencyMs: number;
  lastSeen: number;
}

/* ------------------------------------------------- automation audit trail */

export type AuditActor = 'engine' | 'relay' | 'desktop' | 'user';

/**
 * Every automation action, hash-chained so the log is tamper-evident.
 * If the app is clicking inside the user's logged-in accounts they must be
 * able to watch it.
 */
export interface AuditEntry {
  seq: number;
  at: number;
  actor: AuditActor;
  seatId?: string;
  runId?: string;
  action: string;
  target?: string;
  detail?: string;
  ok: boolean;
  /** sha256(prevHash + canonical(entry)) */
  hash: string;
  prevHash: string;
}

/* ------------------------------------------------------------- templates */

export interface PromptTemplate {
  id: string;
  description: string;
  /** Mustache-lite body: {{var}} and {{#var}}...{{/var}} sections. */
  body: string;
  /** True when the user has edited it away from the shipped default. */
  customised: boolean;
  variables: string[];
}
