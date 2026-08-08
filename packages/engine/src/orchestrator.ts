import type {
  ConsensusReport,
  EngineEvent,
  RunControl,
  RunOutcome,
  RunRecord,
  RunSeatState,
  RunSettings,
  SeatConfig,
  SeatFailureReason,
  SeatTurn,
  CrossCheckResult,
  SeatReliability,
  TaskClassification,
  TransportFamily,
  Verdict,
} from '@consensus/shared';
import { FAMILY_OF, assignLetters } from '@consensus/shared';

import { AdapterError, type ModelAdapter } from './adapters/types.js';
import type { Store } from './db/store.js';
import { createJudge, deriveKeyFromAnswer, normalizeKey, type Judge, type JudgeInput } from './judges/index.js';
import { templates } from './prompts/loader.js';
import { classifyHeuristic, isDebatable, needsLlmClassification, parseClassification } from './protocol/classify.js';
import { newOscillationState, recordRound, type OscillationState } from './protocol/oscillation.js';
import { extractAnswerAndKey, parseVerdict } from './protocol/parser.js';
import { computeCritics, contestedSeats, pruningSavings } from './protocol/pruning.js';
import {
  buildClassifyPrompt,
  buildCrossCheckPrompt,
  buildDispatchPrompt,
  buildJudgePrompt,
  buildRepairPrompt,
  buildRevisePrompt,
  buildRewritePrompt,
} from './protocol/roundBuilder.js';
import type { PeerBlockInput } from './protocol/sanitize.js';
import {
  calibrateConfidence,
  scoreSelfConsistency,
  vendorOf,
} from './verification/index.js';
import { audit } from './runtime/audit.js';
import { BudgetLedger } from './runtime/budget.js';
import { CircuitBreaker } from './runtime/circuitBreaker.js';
import { killSwitch } from './runtime/killSwitch.js';
import { pool, sleep, withTimeout } from './util/async.js';
import { id as makeId, shortHash } from './util/hash.js';
import { logger } from './util/logger.js';

const log = logger('orchestrator');

const TEMPLATE_IDS = [
  'dispatch',
  'cross_judge',
  'cross_revise',
  'stubbornness',
  'final_rewrite',
  'repair',
  'classify',
  'cross_check',
];

export interface RunDeps {
  store: Store;
  adapters: Map<string, ModelAdapter>;
  seats: SeatConfig[];
  ledger: BudgetLedger;
  emit: (event: EngineEvent) => void;
}

interface Position {
  answer: string;
  key: string;
  /** True when the model gave prose but no explicit key and we derived one. */
  derived: boolean;
}

/**
 * One execution of the cross-examination protocol.
 *
 * The shape of a round after the first:
 *   judge call   -> "are these the same claim?"    (no rewriting allowed)
 *   revise call  -> "given that, what is your answer?"  (only if still contested)
 *
 * These are deliberately separate calls: making a model judge and defendant in
 * the same breath biases both.
 */
export class RunExecution {
  readonly record: RunRecord;

  private readonly breaker = new CircuitBreaker();
  private readonly oscillation: OscillationState = newOscillationState();
  private readonly positions = new Map<string, Position>();
  private readonly firstRoundKeys = new Map<string, string>();
  /** judgeSeatId -> the seats it currently considers wrong. Survives pruning. */
  private readonly objections = new Map<string, Set<string>>();
  private readonly unspecificObjectors = new Set<string>();
  private readonly judge: Judge;
  private readonly seatById = new Map<string, SeatConfig>();
  private readonly startedAt = Date.now();

  private abort = new AbortController();
  private paused = false;
  private stepGate: (() => void) | null = null;
  private approvalGate: ((edited?: Record<string, string>) => void) | null = null;
  private humanVerdictGate: ((decision: { equivalent: boolean; note?: string }) => void) | null = null;
  private pendingPrompts: Record<string, string> = {};
  private killUnsub: (() => void) | null = null;

  constructor(
    prompt: string,
    settings: RunSettings,
    private readonly deps: RunDeps,
  ) {
    const seats = deps.seats.filter((s) => s.enabled && deps.adapters.has(s.id));
    for (const s of seats) this.seatById.set(s.id, s);

    const seatStates: Record<string, RunSeatState> = {};
    for (const seat of seats) {
      this.breaker.register(seat.id);
      seatStates[seat.id] = {
        seatId: seat.id,
        displayName: seat.displayName,
        adapter: seat.adapter,
        family: FAMILY_OF[seat.adapter],
        status: 'healthy',
        answer: null,
        answerKey: null,
        flips: 0,
        agreedRounds: [],
        messagesUsed: 0,
      };
    }

    this.record = {
      id: makeId('run'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      prompt,
      title: prompt.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled run',
      status: 'queued',
      outcome: null,
      settings,
      classification: null,
      seatIds: seats.map((s) => s.id),
      primarySeatId: seats.find((s) => s.primary)?.id ?? seats[0]?.id ?? null,
      rounds: [],
      seats: seatStates,
      finalAnswer: null,
      finalAnswerKey: null,
      templateSnapshot: templates.snapshot(TEMPLATE_IDS),
      verification: null,
      stats: {
        calls: 0,
        failedCalls: 0,
        rounds: 0,
        wallMs: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        messagesPerSeat: {},
      },
    };

    this.judge = createJudge({
      kind: settings.judge,
      taskType: null,
      llm: this.pickJudgeSeat(seats),
      ask: (_inputs, _ctx, suggestion) => this.awaitHumanVerdict(suggestion),
    });

    deps.ledger.startRun(this.record.seatIds);
  }

  /* ------------------------------------------------------------- lifecycle */

  async start(): Promise<RunRecord> {
    this.killUnsub = killSwitch.subscribe((engaged) => {
      if (engaged) this.abort.abort(new Error('kill switch engaged'));
    });

    try {
      this.setStatus('running');
      this.deps.emit({ type: 'run:created', run: this.record });

      await this.classify();

      const debatable = isDebatable(this.record.classification, this.record.settings.forceDebate);
      await this.dispatchRound();

      if (!this.alive().length) return this.finish('quorum_lost');

      if (!debatable) {
        log.info(`run ${this.record.id}: ${this.record.classification?.type} prompt — showing answers side by side`);
        return this.finish('no_debate');
      }

      const first = await this.judgePanel(1);
      this.setRoundConsensus(1, first);
      if (first.equivalent) return this.finish('converged');

      if (!this.breaker.hasQuorum()) return this.finish('quorum_lost');

      return await this.debate();
    } catch (err) {
      if (this.abort.signal.aborted) return this.finish('aborted');
      const message = err instanceof Error ? err.message : String(err);
      log.error(`run ${this.record.id} failed: ${message}`);
      this.record.error = message;
      return this.finish('error');
    } finally {
      this.killUnsub?.();
    }
  }

  control(cmd: RunControl): void {
    switch (cmd.kind) {
      case 'pause':
        this.paused = true;
        this.setStatus('paused');
        break;
      case 'resume':
        this.paused = false;
        this.setStatus('running');
        this.stepGate?.();
        this.stepGate = null;
        break;
      case 'step':
        this.stepGate?.();
        this.stepGate = null;
        break;
      case 'approve':
        this.approvalGate?.(cmd.edited);
        this.approvalGate = null;
        break;
      case 'verdict':
        this.humanVerdictGate?.({ equivalent: cmd.equivalent, note: cmd.note });
        this.humanVerdictGate = null;
        break;
      case 'dropSeat':
        this.breaker.drop(cmd.seatId, this.record.rounds.length, 'aborted');
        this.markSeatDropped(cmd.seatId, 'aborted', cmd.reason);
        break;
      case 'abort':
        this.abort.abort(new Error('aborted by user'));
        break;
    }
  }

  /* ------------------------------------------------------------ the phases */

  private async classify(): Promise<void> {
    let classification: TaskClassification = classifyHeuristic(this.record.prompt);

    if (needsLlmClassification(classification)) {
      const seatId = this.cheapestSeat();
      if (seatId) {
        try {
          const built = buildClassifyPrompt(this.record.prompt);
          const { raw } = await this.callSeat(seatId, built.prompt, 'classify', 0);
          classification = parseClassification(raw, classification);
        } catch {
          log.debug('LLM classification failed; keeping the heuristic result');
        }
      }
    }

    this.record.classification = classification;
    this.deps.emit({ type: 'run:classified', runId: this.record.id, classification });
    this.persist();
  }

  /** Phase 1 — parallel dispatch to every enabled seat. */
  private async dispatchRound(): Promise<void> {
    const round = 1;
    const seatIds = this.alive();
    const letters = assignLetters(seatIds, this.record.id, round);

    this.record.rounds.push({
      round,
      letters,
      critics: {},
      stateHash: '',
      consensus: null,
      startedAt: Date.now(),
    });
    this.deps.emit({ type: 'round:start', runId: this.record.id, round, letters });

    const requireKey = this.record.settings.judge !== 'llm';
    const built = buildDispatchPrompt(this.record.prompt, requireKey);

    await this.gateOnApproval(round, Object.fromEntries(seatIds.map((id) => [id, built.prompt])));

    await pool(
      seatIds.map((seatId) => async () => {
        const prompt = this.pendingPrompts[seatId] ?? built.prompt;
        const { raw, turn } = await this.callSeat(seatId, prompt, 'dispatch', round, letters[seatId]);
        const { answer, key } = extractAnswerAndKey(raw);
        const derived = !key;
        const finalKey = key ?? deriveKeyFromAnswer(answer);
        this.setPosition(seatId, { answer, key: finalKey, derived }, round);
        this.firstRoundKeys.set(seatId, normalizeKey(finalKey));
        this.annotateTurn(turn, { answer, answerKey: finalKey });
      }),
      this.concurrencyLimit(),
    );

    this.pendingPrompts = {};
    this.closeRound(round);
  }

  /** Phases 2 and 3 — cross-examination, pruning, and the stop conditions. */
  private async debate(): Promise<RunRecord> {
    let previousCritics: Record<string, string[]> | null = null;

    for (let round = 2; round <= this.record.settings.maxRounds; round++) {
      if (this.abort.signal.aborted) return this.finish('aborted');
      if (Date.now() - this.startedAt > this.record.settings.runTimeoutMs) return this.finish('timeout');
      if (!this.breaker.hasQuorum()) return this.finish('quorum_lost');

      await this.gateOnPause();
      if (this.shouldHandOver(round)) this.record.settings.mode = 'manual';

      const seatIds = this.alive();
      const letters = assignLetters(seatIds, this.record.id, round);
      this.record.rounds.push({
        round,
        letters,
        critics: {},
        stateHash: '',
        consensus: null,
        startedAt: Date.now(),
      });
      this.deps.emit({ type: 'round:start', runId: this.record.id, round, letters });

      // Who takes part this round. From round 3 on, a seat nobody objects to
      // has nothing left to answer and is pruned out entirely.
      const participants =
        round === 2 || !previousCritics
          ? seatIds
          : seatIds.filter((id) => (previousCritics?.[id] ?? []).length > 0);

      if (participants.length === 0) {
        this.closeRound(round);
        const settled = await this.judgePanel(round);
        this.setRoundConsensus(round, settled);
        return this.finish(settled.equivalent ? 'converged' : 'converged_contested');
      }

      /* -- call 1: judge ---------------------------------------------------- */
      const judgeVerdicts = new Map<string, Verdict>();
      const judgePrompts: Record<string, string> = {};
      const judgePeerLetters = new Map<string, string[]>();

      for (const seatId of participants) {
        const peers = this.peersFor(seatId, seatIds, letters, previousCritics, round, null);
        if (!peers.length) continue;
        judgePrompts[seatId] = buildJudgePrompt({
          userPrompt: this.record.prompt,
          selfLetter: letters[seatId] ?? '?',
          selfAnswer: this.positions.get(seatId)?.answer ?? '',
          peers,
          panelSize: seatIds.length,
        }).prompt;
        judgePeerLetters.set(seatId, this.lettersOf(peers));
      }

      await this.gateOnApproval(round, judgePrompts);

      await pool(
        Object.entries(judgePrompts).map(([seatId, prompt]) => async () => {
          const sent = this.pendingPrompts[seatId] ?? prompt;
          const verdict = await this.callForVerdict(
            seatId,
            sent,
            'judge',
            round,
            letters[seatId],
            judgePeerLetters.get(seatId) ?? [],
            false,
          );
          if (verdict) judgeVerdicts.set(seatId, verdict);
        }),
        this.concurrencyLimit(),
      );

      this.pendingPrompts = {};

      // Who is still accused, according to this round's judgements.
      const judged = computeCritics({
        seatIds: this.alive(),
        letters,
        verdicts: Object.fromEntries(this.alive().map((id) => [id, judgeVerdicts.get(id)])),
      });
      const contested = contestedSeats(judged.critics).filter((id) => participants.includes(id));

      /* -- call 2: revise --------------------------------------------------- */
      const reviseVerdicts = new Map<string, Verdict>();
      if (contested.length) {
        const revisePrompts: Record<string, string> = {};
        const revisePeerLetters = new Map<string, string[]>();

        for (const seatId of contested) {
          const peers = this.peersFor(seatId, seatIds, letters, previousCritics, round, judged.critics);
          if (!peers.length) continue;
          revisePrompts[seatId] = buildRevisePrompt({
            userPrompt: this.record.prompt,
            selfLetter: letters[seatId] ?? '?',
            selfAnswer: this.positions.get(seatId)?.answer ?? '',
            peers,
            panelSize: seatIds.length,
            stubbornness: this.record.settings.stubbornness,
            isFollowup: round >= 3,
          }).prompt;
          revisePeerLetters.set(seatId, this.lettersOf(peers));
        }

        await this.gateOnApproval(round, revisePrompts);

        await pool(
          Object.entries(revisePrompts).map(([seatId, prompt]) => async () => {
            const sent = this.pendingPrompts[seatId] ?? prompt;
            const verdict = await this.callForVerdict(
              seatId,
              sent,
              'revise',
              round,
              letters[seatId],
              revisePeerLetters.get(seatId) ?? [],
              true,
            );
            if (!verdict) return;
            reviseVerdicts.set(seatId, verdict);
            if (verdict.answer) {
              const key = verdict.answer_key ?? deriveKeyFromAnswer(verdict.answer);
              this.setPosition(seatId, { answer: verdict.answer, key, derived: !verdict.answer_key }, round);
            }
          }),
          this.concurrencyLimit(),
        );

        this.pendingPrompts = {};
      }

      /* -- fold the round --------------------------------------------------- */
      const latest = new Map<string, Verdict>();
      for (const [id, v] of judgeVerdicts) latest.set(id, v);
      for (const [id, v] of reviseVerdicts) latest.set(id, v);

      for (const [seatId, verdict] of latest) {
        if (verdict.agree) this.record.seats[seatId]?.agreedRounds.push(round);
      }

      // Objections are stored by seat id, resolved with the letter map of the
      // round they were stated in. Letters are reshuffled every round, so a
      // letter-keyed critique is only meaningful inside its own round.
      this.absorbObjections(latest, letters, seatIds);

      const alive = this.alive();
      const { critics, unspecific } = this.deriveCritics(alive);
      if (unspecific.length) {
        log.warn(`round ${round}: ${unspecific.join(', ')} disagreed without naming anyone`);
      }

      const roundRecord = this.record.rounds.at(-1)!;
      roundRecord.critics = critics;

      const savings = pruningSavings(critics, alive.length);
      log.info(
        `round ${round}: ${alive.length} seats, ${contested.length} contested, ` +
          `pruning removed ${(savings.savedFraction * 100).toFixed(0)}% of debate edges`,
      );

      this.closeRound(round);

      /* -- stop conditions -------------------------------------------------- */
      const consensus = await this.judgePanel(round);
      this.setRoundConsensus(round, consensus);

      const survivors = this.alive();
      // "Every model returned the agreement token",
      // expressed over the standing objection map so that seats pruned out of
      // this round -- which had already conceded -- count correctly.
      const noObjections = survivors.length > 0 && survivors.every((id) => (critics[id] ?? []).length === 0);

      // Both signals must hold to call it converged. Either one alone is
      // reported honestly as contested rather than dressed up as agreement:
      // the app never invents a consensus it did not observe.
      if (consensus.equivalent && noObjections) return this.finish('converged');
      if (consensus.equivalent || noObjections) return this.finish('converged_contested');

      const osc = recordRound(
        this.oscillation,
        survivors.map((id) => normalizeKey(this.positions.get(id)?.key ?? '')),
      );
      roundRecord.stateHash = osc.hash;
      if (osc.oscillating) {
        log.warn(
          `round ${round}: the panel returned to the state it was in at round ${osc.repeatOfRound} ` +
            `(cycle length ${osc.cycleLength}); stopping`,
        );
        return this.finish('oscillating');
      }

      previousCritics = critics;
    }

    return this.finish('unresolved');
  }

  /* -------------------------------------------------------------- helpers */

  private peersFor(
    seatId: string,
    seatIds: string[],
    letters: Record<string, string>,
    previousCritics: Record<string, string[]> | null,
    round: number,
    thisRoundCritics: Record<string, string[]> | null,
  ): PeerBlockInput[] {
    // Round 2 shows everyone. From round 3 the prompt contains only the seats
    // that still consider this one wrong -- conceded critics drop out, which is
    // the adaptive pruning of the debate graph.
    let peerIds: string[];
    if (thisRoundCritics) {
      peerIds = thisRoundCritics[seatId] ?? [];
    } else if (round === 2 || !previousCritics) {
      peerIds = seatIds.filter((id) => id !== seatId);
    } else {
      peerIds = previousCritics[seatId] ?? [];
    }

    return peerIds
      .filter((id) => id !== seatId && this.positions.has(id))
      .map((id) => {
        const critique = thisRoundCritics ? this.critiqueOf(id, seatId, letters) : null;
        return {
          letter: letters[id] ?? '?',
          answer: this.positions.get(id)!.answer,
          critique,
        };
      });
  }

  /**
   * Fold this round's verdicts into the standing objection map.
   *
   * `objections[judge]` is the set of seats that judge currently considers
   * wrong. A seat that did not take part this round keeps its previous entry:
   * its position has not changed, so neither have its objections. Storing seat
   * ids rather than letters is what makes that carry-forward sound, because the
   * letter assignment is deliberately reshuffled every round.
   */
  private absorbObjections(
    verdicts: Map<string, Verdict>,
    letters: Record<string, string>,
    seatIds: string[],
  ): void {
    const bySeat: Record<string, string> = {};
    for (const [seatId, letter] of Object.entries(letters)) bySeat[letter] = seatId;

    for (const [judgeId, verdict] of verdicts) {
      const objected = new Set<string>();

      if (verdict.critiques && Object.keys(verdict.critiques).length > 0) {
        for (const [letter, critique] of Object.entries(verdict.critiques)) {
          if (critique === null) continue;
          const targetId = bySeat[letter];
          if (targetId && targetId !== judgeId && seatIds.includes(targetId)) objected.add(targetId);
        }
      } else if (!verdict.agree) {
        // Disagreed but named nobody: treated as an objection to every peer
        // rather than silently pruning the debate away.
        for (const id of seatIds) if (id !== judgeId) objected.add(id);
        this.unspecificObjectors.add(judgeId);
      }

      this.objections.set(judgeId, objected);
    }
  }

  /**
   * Invert the objection map: for each seat, who still considers it wrong.
   *
   * Objections are stated during the judge call, which happens *before* the
   * revise call changes anyone's position. So an objection can be resolved by
   * the target simply adopting the objector's claim: if the two now hold the
   * same answer key, the objection was about a position that no longer exists
   * and is dropped. This is an observation, not an assumption of agreement --
   * the keys are compared, not guessed at.
   */
  private deriveCritics(alive: string[]): { critics: Record<string, string[]>; unspecific: string[] } {
    const critics: Record<string, string[]> = {};
    for (const id of alive) critics[id] = [];

    for (const judgeId of alive) {
      const judgeKey = normalizeKey(this.positions.get(judgeId)?.key ?? '');
      for (const targetId of this.objections.get(judgeId) ?? []) {
        if (!alive.includes(targetId)) continue;
        const targetKey = normalizeKey(this.positions.get(targetId)?.key ?? '');
        // The target moved onto the objector's own claim: nothing left to object to.
        if (judgeKey && targetKey && judgeKey === targetKey) {
          this.objections.get(judgeId)?.delete(targetId);
          continue;
        }
        critics[targetId]?.push(judgeId);
      }
    }

    for (const id of alive) critics[id] = [...new Set(critics[id] ?? [])].sort();
    return { critics, unspecific: [...this.unspecificObjectors].filter((id) => alive.includes(id)) };
  }

  /** What critic `criticId` said is wrong with `targetId`'s answer, this round. */
  private critiqueOf(criticId: string, targetId: string, letters: Record<string, string>): string | null {
    const targetLetter = letters[targetId];
    if (!targetLetter) return null;
    const turns = this.turnsThisRound.get(criticId);
    const verdict = turns?.verdict;
    return verdict?.critiques?.[targetLetter] ?? null;
  }

  private turnsThisRound = new Map<string, { verdict?: Verdict }>();

  private lettersOf(peers: PeerBlockInput[]): string[] {
    return peers.map((p) => p.letter);
  }

  private alive(): string[] {
    return this.record.seatIds.filter((id) => !this.breaker.isDropped(id));
  }

  private concurrencyLimit(): number {
    // Seats that declare themselves non-concurrent (relay, desktop) are still
    // run in parallel across *different* providers; the per-provider serialism
    // is enforced inside the relay hub, not here.
    return Math.max(1, Math.min(8, this.record.seatIds.length));
  }

  private setPosition(seatId: string, position: Position, round: number): void {
    const previous = this.positions.get(seatId);
    if (previous && normalizeKey(previous.key) !== normalizeKey(position.key)) {
      const state = this.record.seats[seatId];
      if (state) state.flips++;
      log.info(`round ${round}: ${seatId} changed its answer (${previous.key} -> ${position.key})`);
    }
    this.positions.set(seatId, position);
    const state = this.record.seats[seatId];
    if (state) {
      state.answer = position.answer;
      state.answerKey = position.key;
    }
  }

  private async judgePanel(round: number): Promise<ConsensusReport> {
    const seatIds = this.alive();
    const letters = this.record.rounds.at(-1)?.letters ?? {};
    const inputs: JudgeInput[] = seatIds
      .filter((id) => this.positions.has(id))
      .map((id) => {
        const pos = this.positions.get(id)!;
        return {
          seatId: id,
          letter: letters[id] ?? '?',
          answer: pos.answer,
          answerKey: pos.key,
          keyWasDerived: pos.derived,
        };
      });

    return this.judge.compare(inputs, {
      runId: this.record.id,
      round,
      prompt: this.record.prompt,
      taskType: this.record.classification?.type ?? null,
      settings: this.record.settings,
    });
  }

  private setRoundConsensus(round: number, consensus: ConsensusReport): void {
    const rec = this.record.rounds.find((r) => r.round === round);
    if (rec) rec.consensus = consensus;
    this.deps.emit({ type: 'round:end', runId: this.record.id, round, consensus });
    this.persist();
  }

  private closeRound(round: number): void {
    const rec = this.record.rounds.find((r) => r.round === round);
    if (rec) rec.finishedAt = Date.now();
    this.record.stats.rounds = this.record.rounds.length;
    this.turnsThisRound.clear();
    this.persist();
  }

  /* ------------------------------------------------------------ model calls */

  /**
   * Update a turn after its reply has been parsed, so the stored record carries
   * the verdict and the extracted answer -- the run report and the eval harness
   * both read round-1 answers back out of this table.
   */
  private annotateTurn(turn: SeatTurn, patch: Partial<SeatTurn>): void {
    Object.assign(turn, patch);
    if (patch.answerKey) turn.answerHash = shortHash(normalizeKey(patch.answerKey), 16);
    this.deps.store.saveTurn(turn);
  }

  /** One model call, with budget, breaker, timeout, persistence and audit. */
  private async callSeat(
    seatId: string,
    prompt: string,
    kind: SeatTurn['kind'],
    round: number,
    letter?: string,
  ): Promise<{ raw: string; turn: SeatTurn }> {
    killSwitch.assertClear();

    const seat = this.seatById.get(seatId);
    const adapter = this.deps.adapters.get(seatId);
    if (!seat || !adapter) throw new AdapterError('not_configured', `seat ${seatId} is not available`);

    // Classification is an internal utility call on an unmetered seat, not a
    // panel message. It must never be able to exhaust a seat's budget and drop
    // it from the run before it has answered anything.
    const countsAgainstBudget = kind !== 'classify';

    // Quota exhaustion is a normal circuit-breaker drop, not an error (4.4b).
    if (countsAgainstBudget) {
      const budget = this.deps.ledger.check(seat, this.record.settings);
      if (!budget.ok) {
        this.failSeat(seatId, 'budget_exhausted', round, budget.detail);
        throw new AdapterError('budget_exhausted', budget.detail);
      }
    }

    if (this.breaker.isCoolingDown(seatId)) {
      await sleep(this.breaker.backoffFor(seatId), this.abort.signal);
    }

    const startedAt = Date.now();
    this.deps.emit({ type: 'turn:start', runId: this.record.id, round, seatId, kind, prompt });

    const turnId = makeId('turn');
    let raw = '';

    try {
      const result = await withTimeout(
        adapter.send(prompt, {
          timeoutMs: this.record.settings.callTimeoutMs,
          signal: this.abort.signal,
          newThread: kind === 'dispatch' || round >= 2,
          onDelta: (delta) => {
            this.deps.emit({ type: 'turn:delta', runId: this.record.id, seatId, turnId, delta });
          },
        }),
        this.record.settings.callTimeoutMs,
      );

      raw = result.text;
      if (countsAgainstBudget) {
        this.deps.ledger.record(seatId);
        this.deps.store.recordMessage(seatId);
      }
      this.breaker.recordSuccess(seatId);

      const state = this.record.seats[seatId];
      if (state) {
        if (countsAgainstBudget) state.messagesUsed++;
        state.status = 'healthy';
        if (result.lossy) state.lossy = true;
      }

      this.record.stats.calls++;
      this.record.stats.tokensIn += result.tokens?.in ?? 0;
      this.record.stats.tokensOut += result.tokens?.out ?? 0;
      this.record.stats.costUsd += result.costUsd ?? 0;
      this.record.stats.messagesPerSeat[seatId] = (this.record.stats.messagesPerSeat[seatId] ?? 0) + 1;

      const turn: SeatTurn = {
        id: turnId,
        runId: this.record.id,
        round,
        seatId,
        kind,
        letter,
        promptHash: shortHash(prompt),
        prompt,
        raw,
        latencyMs: Date.now() - startedAt,
        tokens: result.tokens,
        costUsd: result.costUsd,
        lossy: result.lossy,
        startedAt,
        finishedAt: Date.now(),
      };
      this.deps.store.saveTurn(turn);
      this.deps.emit({ type: 'turn:end', runId: this.record.id, turn });

      audit.record({
        actor: adapter.family === 'relay' ? 'relay' : adapter.family === 'desktop' ? 'desktop' : 'engine',
        seatId,
        runId: this.record.id,
        action: `${kind}.send`,
        target: adapter.displayName,
        detail: `${prompt.length} chars in, ${raw.length} chars out${result.lossy ? ' (LOSSY)' : ''}`,
        ok: true,
      });

      return { raw, turn };
    } catch (err) {
      const reason: SeatFailureReason =
        err instanceof AdapterError ? err.reason : this.abort.signal.aborted ? 'aborted' : 'timeout';
      const detail = err instanceof Error ? err.message : String(err);

      this.record.stats.failedCalls++;
      this.deps.store.saveTurn({
        id: turnId,
        runId: this.record.id,
        round,
        seatId,
        kind,
        letter,
        promptHash: shortHash(prompt),
        prompt,
        raw: '',
        latencyMs: Date.now() - startedAt,
        failure: { reason, detail },
        startedAt,
        finishedAt: Date.now(),
      });

      audit.record({
        actor: 'engine',
        seatId,
        runId: this.record.id,
        action: `${kind}.send`,
        detail: `${reason}: ${detail.slice(0, 160)}`,
        ok: false,
      });

      this.failSeat(seatId, reason, round, detail);
      throw err;
    }
  }

  /**
   * A model call that must produce a verdict. On a malformed reply we retry
   * once with a repair prompt; a second failure marks the seat NON_COMPLIANT
   * for the round and excludes it, without crashing the run.
   */
  private async callForVerdict(
    seatId: string,
    prompt: string,
    kind: 'judge' | 'revise',
    round: number,
    letter: string | undefined,
    peerLetters: string[],
    needAnswer: boolean,
  ): Promise<Verdict | null> {
    let raw: string;
    let turn: SeatTurn;
    try {
      ({ raw, turn } = await this.callSeat(seatId, prompt, kind, round, letter));
    } catch {
      return null; // already classified, recorded and fed to the breaker
    }

    let parsed = parseVerdict(raw, { expectedLetters: peerLetters });
    if (parsed.verdict) {
      this.recordVerdict(seatId, parsed.verdict);
      this.annotateTurn(turn, {
        verdict: parsed.verdict,
        parseSource: parsed.source,
        answer: parsed.verdict.answer,
        answerKey: parsed.verdict.answer_key,
      });
      if (parsed.warnings.length) log.debug(`${seatId} round ${round}: ${parsed.warnings.join('; ')}`);
      return parsed.verdict;
    }

    log.warn(`${seatId} round ${round}: reply did not match the verdict contract; retrying once`);
    try {
      const repair = `${prompt}\n\n---\n${buildRepairPrompt(peerLetters, needAnswer)}\n\nYour previous reply was:\n${raw.slice(0, 2000)}`;
      const retried = await this.callSeat(seatId, repair, 'repair', round, letter);
      parsed = parseVerdict(retried.raw, { expectedLetters: peerLetters });
      if (parsed.verdict) {
        this.recordVerdict(seatId, parsed.verdict);
        this.annotateTurn(retried.turn, {
          verdict: parsed.verdict,
          parseSource: 'repaired',
          answer: parsed.verdict.answer,
          answerKey: parsed.verdict.answer_key,
        });
        return parsed.verdict;
      }
      this.annotateTurn(retried.turn, { parseSource: 'malformed' });
    } catch {
      /* fall through to non-compliant */
    }

    this.annotateTurn(turn, { parseSource: 'malformed' });

    log.warn(`${seatId} round ${round}: still non-compliant; excluded from this round`);
    audit.record({
      actor: 'engine',
      seatId,
      runId: this.record.id,
      action: 'verdict.non_compliant',
      detail: `round ${round}: two malformed replies; excluded from this round`,
      ok: false,
    });
    this.deps.store.bumpScoreboard({
      seatId,
      displayName: this.record.seats[seatId]?.displayName ?? seatId,
      nonCompliant: 1,
    });
    // Not a transport failure: the seat stays in the panel and may comply next round.
    return null;
  }

  /** Keep this round's verdict so the revise prompts can quote each critic's own words. */
  private recordVerdict(seatId: string, verdict: Verdict): void {
    this.turnsThisRound.set(seatId, { verdict });
  }

  private failSeat(seatId: string, reason: SeatFailureReason, round: number, detail?: string): void {
    const outcome = this.breaker.recordFailure(seatId, reason, round, detail);
    const state = this.record.seats[seatId];
    if (state) state.status = outcome.status;

    this.deps.emit({
      type: 'seat:status',
      runId: this.record.id,
      seatId,
      status: outcome.status,
      reason,
      detail,
    });

    if (outcome.dropped) this.markSeatDropped(seatId, reason, detail, round);
    this.persist();
  }

  /**
   * Graceful panel shrinkage: the seat leaves the loop but
   * its last answer is retained and displayed, and quorum is recomputed.
   */
  private markSeatDropped(seatId: string, reason: SeatFailureReason, detail?: string, round?: number): void {
    const state = this.record.seats[seatId];
    if (!state) return;
    state.status = 'dropped';
    state.dropReason = reason;
    state.droppedAtRound = round ?? this.record.rounds.length;
    log.warn(
      `${seatId} withdrew at round ${state.droppedAtRound} (${reason}); its last answer is kept and shown`,
    );
    audit.record({
      actor: 'engine',
      seatId,
      runId: this.record.id,
      action: 'seat.dropped',
      detail: `${reason}${detail ? `: ${detail.slice(0, 160)}` : ''}`,
      ok: false,
    });
  }

  /* --------------------------------------------------------------- gating */

  private shouldHandOver(round: number): boolean {
    const { mode, handoverRound } = this.record.settings;
    return mode === 'semi' && handoverRound !== undefined && round > handoverRound;
  }

  private async gateOnPause(): Promise<void> {
    if (!this.paused) return;
    this.setStatus('paused');
    await new Promise<void>((resolve) => {
      this.stepGate = resolve;
    });
    this.setStatus('running');
  }

  /**
   * Manual mode: the user approves each round and may edit any generated prompt
   * before it is sent.
   */
  private async gateOnApproval(round: number, prompts: Record<string, string>): Promise<void> {
    if (this.record.settings.mode !== 'manual') return;
    if (Object.keys(prompts).length === 0) return;

    this.setStatus('awaiting_approval');
    this.deps.emit({ type: 'run:awaiting', runId: this.record.id, round, prompts });

    const edited = await new Promise<Record<string, string> | undefined>((resolve) => {
      this.approvalGate = resolve;
    });

    if (edited) this.pendingPrompts = { ...prompts, ...edited };
    else this.pendingPrompts = prompts;
    this.setStatus('running');
  }

  private awaitHumanVerdict(suggestion: ConsensusReport): Promise<{ equivalent: boolean; note?: string }> {
    this.setStatus('awaiting_approval');
    this.deps.emit({
      type: 'run:awaiting',
      runId: this.record.id,
      round: this.record.rounds.length,
      prompts: { __judge__: JSON.stringify(suggestion, null, 2) },
    });
    return new Promise((resolve) => {
      this.humanVerdictGate = (decision) => {
        this.setStatus('running');
        resolve(decision);
      };
    });
  }

  /* --------------------------------------------------------------- finish */

  private async finish(outcome: RunOutcome): Promise<RunRecord> {
    this.record.outcome = outcome;
    this.record.status = outcome === 'aborted' ? 'aborted' : outcome === 'error' ? 'error' : 'done';
    this.record.stats.wallMs = Date.now() - this.startedAt;

    const consensus = this.record.rounds.at(-1)?.consensus ?? null;
    const winning = consensus?.camps[0];

    if (outcome === 'converged' || outcome === 'converged_contested') {
      const primary = this.record.primarySeatId;
      const fromPrimary =
        primary && winning?.seatIds.includes(primary) ? this.positions.get(primary)?.answer : undefined;
      this.record.finalAnswer = fromPrimary ?? winning?.representativeAnswer ?? null;
      this.record.finalAnswerKey = winning?.label ?? null;

      // Verification runs before the optional rewrite so it checks the answer
      // the panel actually agreed on, not a restatement of it.
      await this.verify(consensus);

      if (this.record.settings.finalRewrite && this.record.finalAnswer) {
        await this.finalRewrite(this.record.finalAnswer);
      }
    } else if (outcome === 'no_debate') {
      const primary = this.record.primarySeatId;
      this.record.finalAnswer = primary ? this.positions.get(primary)?.answer ?? null : null;
    }

    this.updateScoreboard(outcome);
    this.persist();
    this.deps.emit({ type: 'run:status', runId: this.record.id, status: this.record.status, outcome });
    this.deps.emit({ type: 'run:done', run: this.record });

    log.info(
      `run ${this.record.id} finished: ${outcome} in ${this.record.stats.rounds} round(s), ` +
        `${this.record.stats.calls} call(s), ${(this.record.stats.wallMs / 1000).toFixed(1)}s`,
    );
    return this.record;
  }

  /**
   * Self-consistency, cross-check and calibrated confidence.
   *
   * Both checks are opt-in because both cost real messages from the quota that
   * is the binding constraint on the whole app. When they are off, confidence
   * is still calibrated from the signals the run produced for free — agreement,
   * heterogeneity, flips, fidelity — so the user always gets an itemised score
   * rather than a bare "converged".
   */
  private async verify(consensus: ConsensusReport | null): Promise<void> {
    const reliability: SeatReliability[] = [];
    const survivors = this.alive();

    /* --- self-consistency: does each seat agree with itself? -------------- */
    const samples = this.record.settings.selfConsistencySamples;
    const contested = this.record.outcome !== 'converged' || (consensus?.camps.length ?? 1) > 1;

    if (samples > 0 && (contested || this.record.outcome === 'converged')) {
      const built = buildDispatchPrompt(this.record.prompt, true);

      await pool(
        survivors.map((seatId) => async () => {
          const adapter = this.deps.adapters.get(seatId);
          const declared = this.positions.get(seatId)?.key;
          if (!adapter || !declared) return;

          // A UI-driven seat cannot vary temperature, so resampling it just
          // asks the same question twice and proves nothing about variance.
          if (!adapter.capabilities.temperature) {
            log.debug(`${seatId}: skipping self-consistency, transport cannot vary temperature`);
            return;
          }

          const resampled: string[] = [];
          for (let i = 0; i < samples; i++) {
            try {
              const raw = await this.callSeat(seatId, built.prompt, 'verify', this.record.rounds.length);
              const { answer, key } = extractAnswerAndKey(raw.raw);
              const resolved = key ?? deriveKeyFromAnswer(answer);
              resampled.push(resolved);
              this.annotateTurn(raw.turn, { answer, answerKey: resolved });
            } catch {
              break; // a failed resample is missing evidence, not a run failure
            }
          }

          if (resampled.length) {
            reliability.push(
              scoreSelfConsistency({
                seatId,
                declaredKey: declared,
                resampledKeys: resampled,
                tolerance: this.record.settings.numericTolerance,
              }),
            );
          }
        }),
        this.concurrencyLimit(),
      );
    }

    /* --- cross-check: let a dissenter review the winner ------------------- */
    let crossCheck: CrossCheckResult | undefined;
    const winning = consensus?.camps[0];

    if (this.record.settings.crossCheck && winning && this.record.finalAnswer) {
      // Prefer a seat that held a different position: a dissenter is a far
      // harsher reviewer than another member of the majority.
      const dissenters = survivors.filter((id) => !winning.seatIds.includes(id));
      const verifierId = dissenters[0] ?? survivors.find((id) => id !== this.record.primarySeatId);

      if (verifierId) {
        try {
          const built = buildCrossCheckPrompt(this.record.prompt, this.record.finalAnswer);
          const { raw, turn } = await this.callSeat(verifierId, built.prompt, 'verify', this.record.rounds.length);
          const parsed = parseVerdict(raw, { expectedLetters: [] });
          this.annotateTurn(turn, { verdict: parsed.verdict ?? undefined, parseSource: parsed.source });

          if (parsed.verdict) {
            crossCheck = {
              verifierSeatId: verifierId,
              wasDissenter: dissenters.includes(verifierId),
              agrees: parsed.verdict.agree,
              objection: parsed.verdict.answer,
            };
          } else {
            // An unreadable review is missing evidence, not a rejection.
            // Recording it as one would invent a negative signal, which is the
            // same failure as inventing a positive one.
            log.warn(
              `cross-check by ${verifierId} could not be parsed; recorded as inconclusive rather than as a rejection`,
            );
          }
        } catch (err) {
          log.warn(`cross-check by ${verifierId} could not be completed: ${String(err)}`);
        }
      }
    }

    /* --- calibrate --------------------------------------------------------- */
    const familyOf: Record<string, TransportFamily> = {};
    const vendors: Record<string, string> = {};
    for (const id of this.record.seatIds) {
      const seat = this.record.seats[id];
      if (!seat) continue;
      familyOf[id] = seat.family;
      vendors[id] = vendorOf(id, seat.adapter);
    }

    this.record.verification = calibrateConfidence({
      run: this.record,
      consensus,
      reliability,
      crossCheck,
      familyOf,
      vendorOf: vendors,
    });

    log.info(
      `run ${this.record.id}: confidence ${(this.record.verification.confidence * 100).toFixed(0)}% ` +
        `(${this.record.verification.band})`,
    );
  }

  private async finalRewrite(agreed: string): Promise<void> {
    const built = buildRewritePrompt(this.record.prompt, agreed);
    const targets = this.record.settings.showOnlyPrimary
      ? [this.record.primarySeatId].filter((x): x is string => Boolean(x))
      : this.alive();

    await pool(
      targets.map((seatId) => async () => {
        try {
          const { raw, turn } = await this.callSeat(seatId, built.prompt, 'rewrite', this.record.rounds.length);
          this.annotateTurn(turn, { answer: raw });
          const state = this.record.seats[seatId];
          if (state) state.answer = raw;
          if (seatId === this.record.primarySeatId) this.record.finalAnswer = raw;
        } catch {
          /* a failed rewrite must not invalidate a converged run */
        }
      }),
      this.concurrencyLimit(),
    );
  }

  /**
   * Lifetime scoreboard.
   *
   * The converged answer is the only ground truth available, so it is used as
   * the proxy -- which is stated in the UI, because convergence is not
   * correctness.
   */
  private updateScoreboard(outcome: RunOutcome): void {
    if (outcome !== 'converged' && outcome !== 'converged_contested') return;
    const finalKey = normalizeKey(this.record.finalAnswerKey ?? '');
    if (!finalKey) return;

    for (const seatId of this.record.seatIds) {
      const state = this.record.seats[seatId];
      if (!state) continue;
      const firstKey = this.firstRoundKeys.get(seatId);
      const lastKey = normalizeKey(state.answerKey ?? '');
      const wasRightFirst = firstKey === finalKey;
      const endedRight = lastKey === finalKey;

      this.deps.store.bumpScoreboard({
        seatId,
        displayName: state.displayName,
        runs: 1,
        correctFirst: wasRightFirst ? 1 : 0,
        overruled: wasRightFirst ? 0 : 1,
        flips: state.flips,
        talkedOutOfCorrect: wasRightFirst && !endedRight ? 1 : 0,
        withdrawals: state.status === 'dropped' ? 1 : 0,
      });
    }
  }

  private setStatus(status: RunRecord['status']): void {
    this.record.status = status;
    this.record.updatedAt = Date.now();
    this.deps.emit({ type: 'run:status', runId: this.record.id, status });
  }

  private persist(): void {
    this.record.updatedAt = Date.now();
    this.deps.store.saveRun(this.record);
  }

  private pickJudgeSeat(seats: SeatConfig[]): { call: (p: string, o: { timeoutMs: number }) => Promise<string>; seatId: string } | undefined {
    // Prefer an unmetered local seat so the judge does not eat subscription quota.
    const preferred =
      seats.find((s) => s.adapter === 'ollama' || s.adapter === 'lmstudio') ??
      seats.find((s) => FAMILY_OF[s.adapter] === 'api') ??
      seats[0];
    if (!preferred) return undefined;
    const adapter = this.deps.adapters.get(preferred.id);
    if (!adapter) return undefined;
    return {
      seatId: preferred.id,
      call: async (prompt, o) => (await adapter.send(prompt, { timeoutMs: o.timeoutMs })).text,
    };
  }

  /**
   * A seat that can answer a utility question without costing anything.
   *
   * Deliberately returns nothing when the panel is all-metered: classifying a
   * prompt is not worth a message from a subscription seat, given section
   * 4.4b's arithmetic leaves only ~6-12 runs per five-hour window. With no free
   * seat available the heuristic classifier stands on its own.
   */
  private cheapestSeat(): string | undefined {
    return this.deps.seats.find(
      (s) =>
        s.enabled &&
        this.deps.adapters.has(s.id) &&
        (s.adapter === 'ollama' || s.adapter === 'lmstudio' || s.adapter === 'mock'),
    )?.id;
  }
}
