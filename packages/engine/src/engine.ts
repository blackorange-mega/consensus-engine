import type { Server } from 'node:http';

import type {
  ConformanceResult,
  DescriptorPack,
  EngineEvent,
  PreflightEstimate,
  RunControl,
  RunRecord,
  RunSettings,
  SeatConfig,
  SeatHealth,
} from '@consensus/shared';
import { FAMILY_OF } from '@consensus/shared';

import { buildPanel } from './adapters/registry.js';
import { DesktopAdapter } from './adapters/desktop.js';
import { discoverSeats, suggestPanel, type Discovered } from './adapters/discovery.js';
import { FailoverAdapter } from './adapters/failover.js';
import type { ModelAdapter } from './adapters/types.js';
import { CONFIG, ENGINE_VERSION, relayToken } from './config.js';
import {
  loadDescriptorPack,
  loadSeats,
  loadSettings,
  saveDescriptorPack,
  saveSeats,
  saveSettings,
} from './configStore.js';
import { Store } from './db/store.js';
import { RunExecution, type RunDeps } from './orchestrator.js';
import { buildReport, reportToMarkdown, type RunReport } from './report/report.js';
import { audit } from './runtime/audit.js';
import { BudgetLedger, preflight } from './runtime/budget.js';
import { automationPolicy, killSwitch } from './runtime/killSwitch.js';
import { applyRepair, buildRepair, isWorthTrying, parseCandidates } from './relay/selfHeal.js';
import { RelayServer } from './server/relayServer.js';
import { addLogSink } from './util/logger.js';
import { logger } from './util/logger.js';

const log = logger('engine');

/**
 * The engine process.
 *
 * Deliberately headless and separate from any UI: the orchestrator is reachable
 * over HTTP/WebSocket so a phone can open the same
 * interface over the LAN, and so the desktop shell stays swappable. No
 * orchestration logic may depend on a UI framework.
 */
export class Engine {
  readonly store = new Store();
  readonly ledger = new BudgetLedger();

  private seats: SeatConfig[] = [];
  private settings: RunSettings;
  private adapters = new Map<string, ModelAdapter>();
  private runs = new Map<string, RunExecution>();
  private listeners = new Set<(event: EngineEvent) => void>();
  private healthCache = new Map<string, SeatHealth>();
  private relay: RelayServer | null = null;
  private pack: DescriptorPack;

  constructor() {
    this.seats = loadSeats();
    this.settings = loadSettings();
    this.pack = loadDescriptorPack();

    this.ledger.restore(this.store.loadBudgetHistory(Date.now() - CONFIG.budgetWindowMs));
    this.store.pruneBudgetHistory(Date.now() - CONFIG.budgetWindowMs * 7);

    // Everything in the audit trail is persisted and streamed to the UI.
    audit.subscribe((entry) => {
      this.store.appendAudit(entry);
      this.emit({ type: 'audit', entry });
    });

    addLogSink((level, message, at) => this.emit({ type: 'log', level, message, at }));
    killSwitch.subscribe((engaged) => this.emit({ type: 'killswitch', engaged, by: 'user' }));

    this.rebuildAdapters();
    this.reportInterruptedRuns();
  }

  attachRelay(server: Server): void {
    this.relay = new RelayServer(server, relayToken(), this.pack, () => {
      this.rebuildAdapters();
      void this.refreshHealth();
    });
    this.rebuildAdapters();
  }

  /* ------------------------------------------------------------- listeners */

  subscribe(fn: (event: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: EngineEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must never break a run */
      }
    }
  }

  /* ------------------------------------------------------------------ seats */

  getSeats(): SeatConfig[] {
    return this.seats;
  }

  setSeats(seats: SeatConfig[]): SeatConfig[] {
    this.seats = saveSeats(seats);
    this.rebuildAdapters();
    void this.refreshHealth();
    return this.seats;
  }

  getSettings(): RunSettings {
    return this.settings;
  }

  setSettings(patch: Partial<RunSettings>): RunSettings {
    this.settings = saveSettings(patch);
    return this.settings;
  }

  async discover(): Promise<{ found: Discovered[]; suggestion: ReturnType<typeof suggestPanel> }> {
    const found = await discoverSeats({ relayConnected: this.relay?.connected() ?? false });
    return { found, suggestion: suggestPanel(found) };
  }

  private rebuildAdapters(): void {
    const usable = this.seats.filter((s) => {
      if (!automationPolicy.uiAutomationDisabled) return true;
      // "Disable all automation" falls the panel back to CLI/local/API seats so
      // a broken descriptor pack can never brick the app.
      const family = FAMILY_OF[s.adapter];
      return family !== 'relay' && family !== 'desktop';
    });

    const previous = this.adapters;

    const { adapters, failures } = buildPanel(usable, {
      relay: this.relay ?? undefined,
      descriptorFor: (provider) => this.pack.descriptors.find((d) => d.provider === provider),
    });
    this.adapters = adapters;
    for (const f of failures) log.warn(`seat "${f.seatId}" unavailable: ${f.error}`);

    // Release the adapters we just replaced. CDP seats hold a WebSocket to a
    // browser and desktop seats hold a child process, so dropping the reference
    // without disposing leaks both — and rebuilds happen every time the user
    // toggles a seat.
    for (const [seatId, adapter] of previous) {
      if (this.adapters.get(seatId) === adapter) continue; // still in use
      void Promise.resolve(adapter.dispose?.()).catch((err) =>
        log.debug(`disposing "${seatId}" failed: ${String(err)}`),
      );
    }
  }

  /* ----------------------------------------------------------------- health */

  async refreshHealth(): Promise<SeatHealth[]> {
    const results = await Promise.all(
      this.seats
        .filter((s) => s.enabled)
        .map(async (seat): Promise<SeatHealth> => {
          const adapter = this.adapters.get(seat.id);
          const usage = this.ledger.used(seat.id);
          if (!adapter) {
            return {
              seatId: seat.id,
              status: 'dropped',
              family: FAMILY_OF[seat.adapter],
              adapter: seat.adapter,
              capabilities: {
                streaming: false,
                rawCopy: false,
                newThread: false,
                concurrent: false,
                systemPrompt: false,
                temperature: false,
                attachments: false,
                quotaVisible: false,
              },
              conformance: null,
              consecutiveFailures: 0,
              lastFailure: { reason: 'not_configured', at: Date.now() },
              usage,
            };
          }

          const health = await adapter.health().catch((err) => ({
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          }));

          return {
            seatId: seat.id,
            status: health.ok ? 'healthy' : 'degraded',
            family: adapter.family,
            adapter: adapter.kind,
            capabilities: adapter.capabilities,
            conformance: this.healthCache.get(seat.id)?.conformance ?? null,
            consecutiveFailures: 0,
            lastFailure: health.ok ? undefined : { reason: 'network', detail: health.detail, at: Date.now() },
            usage,
            quotaHint: 'quotaHint' in health ? (health.quotaHint as string) : undefined,
            lossy: adapter.capabilities.rawCopy ? false : true,
          };
        }),
    );

    for (const h of results) this.healthCache.set(h.seatId, h);
    this.emit({ type: 'seat:health', health: results });
    return results;
  }

  /** Run the conformance smoke test and show a red/green chip. */
  async runConformance(seatId: string): Promise<ConformanceResult> {
    const adapter = this.adapters.get(seatId);
    if (!adapter) throw new Error(`seat "${seatId}" is not available`);

    if (!adapter.conformance) {
      const health = await adapter.health();
      return {
        ok: health.ok,
        at: Date.now(),
        checks: [{ name: 'reachable', ok: health.ok, detail: health.detail }],
      };
    }

    const result = await adapter.conformance();
    const cached = this.healthCache.get(seatId);
    if (cached) this.healthCache.set(seatId, { ...cached, conformance: result });
    audit.record({
      actor: 'engine',
      seatId,
      action: 'conformance.run',
      detail: result.checks.map((c) => `${c.name}=${c.ok ? 'ok' : 'FAIL'}`).join(', '),
      ok: result.ok,
    });
    return result;
  }

  /**
   * Attempt to repair a stale descriptor.
   *
   * Ask the page to propose selectors, merge them as a candidate, prove the
   * candidate works, and only then cache it. A repair that cannot be proven is
   * reported and discarded — a selector that silently matches the wrong element
   * is worse than one that matches nothing, because it fails without saying so.
   */
  async healDescriptor(provider: string): Promise<{
    ok: boolean;
    detail: string;
    changed?: string[];
    conformance?: ConformanceResult;
  }> {
    const current = this.pack.descriptors.find((d) => d.provider === provider);
    if (!current) return { ok: false, detail: `no descriptor for provider "${provider}"` };
    if (!this.relay?.connected()) {
      return { ok: false, detail: 'self-healing needs the relay extension connected to inspect the page' };
    }

    const seatId = this.seats.find((s) => s.enabled && s.options?.provider === provider)?.id ?? provider;

    const probe = await this.relay.request(seatId, { kind: 'heal', provider }, 45_000);
    if (!probe.ok) return { ok: false, detail: `could not inspect the page: ${probe.detail ?? probe.reason}` };

    const candidates = parseCandidates(probe.text);
    if (!candidates) return { ok: false, detail: 'the page returned an unreadable repair proposal' };

    const repair = buildRepair(current, candidates);
    const worth = isWorthTrying(repair);
    if (!worth.ok) return { ok: false, detail: worth.reason, changed: repair.changed };

    // Stage the candidate, prove it, and roll back if it does not hold up.
    const original = this.pack;
    this.setPack(applyRepair(this.pack, repair.candidate));

    let conformance: ConformanceResult | undefined;
    try {
      conformance = await this.runConformance(seatId);
    } catch (err) {
      this.setPack(original);
      return { ok: false, detail: `the repair could not be tested: ${String(err)}`, changed: repair.changed };
    }

    if (!conformance.ok) {
      this.setPack(original);
      const failed = conformance.checks.filter((c) => !c.ok).map((c) => c.name);
      return {
        ok: false,
        detail: `the repair did not pass its smoke test (${failed.join(', ')}); rolled back to the previous descriptor`,
        changed: repair.changed,
        conformance,
      };
    }

    log.info(`descriptor "${provider}" healed: ${repair.changed.join(', ')}`);
    return {
      ok: true,
      detail: `repaired and verified: ${repair.changed.join(', ')}`,
      changed: repair.changed,
      conformance,
    };
  }

  /* ------------------------------------------------------------------- runs */

  estimate(settingsPatch: Partial<RunSettings> = {}): PreflightEstimate {
    const settings = { ...this.settings, ...settingsPatch };
    const enabled = this.seats.filter((s) => s.enabled && this.adapters.has(s.id));
    return preflight(enabled, settings, this.ledger);
  }

  startRun(prompt: string, settingsPatch: Partial<RunSettings> = {}): RunRecord {
    const settings = { ...this.settings, ...settingsPatch };
    const deps: RunDeps = {
      store: this.store,
      adapters: this.adapters,
      seats: this.seats,
      ledger: this.ledger,
      emit: (event) => this.emit(event),
    };

    const execution = new RunExecution(prompt, settings, deps);
    this.runs.set(execution.record.id, execution);

    // Runs are a background batch job, not a chat turn: fire and
    // walk away, the UI is notified over the event stream.
    void execution.start().catch((err) => log.error(`run ${execution.record.id} threw: ${String(err)}`));

    return execution.record;
  }

  control(runId: string, cmd: RunControl): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`run "${runId}" is not active`);
    run.control(cmd);
  }

  getRun(runId: string): RunRecord | null {
    return this.runs.get(runId)?.record ?? this.store.getRun(runId);
  }

  listRuns(limit = 50) {
    return this.store.listRuns(limit);
  }

  report(runId: string): RunReport | null {
    const run = this.getRun(runId);
    if (!run) return null;
    return buildReport(run, this.store.getTurns(runId));
  }

  reportMarkdown(runId: string): string | null {
    const report = this.report(runId);
    return report ? reportToMarkdown(report) : null;
  }

  /** Full run export/import, for sharing an interesting disagreement. */
  exportRun(runId: string): { run: RunRecord; turns: ReturnType<Store['getTurns']>; report: RunReport } | null {
    const run = this.getRun(runId);
    if (!run) return null;
    const turns = this.store.getTurns(runId);
    return { run, turns, report: buildReport(run, turns) };
  }

  importRun(payload: { run: RunRecord; turns: ReturnType<Store['getTurns']> }): string {
    const run = { ...payload.run, id: `${payload.run.id}-imported` };
    this.store.saveRun(run);
    for (const turn of payload.turns) this.store.saveTurn({ ...turn, runId: run.id });
    return run.id;
  }

  scoreboard() {
    return this.store.scoreboard();
  }

  /* ------------------------------------------------------------ descriptors */

  getPack(): DescriptorPack {
    return this.pack;
  }

  setPack(pack: DescriptorPack): DescriptorPack {
    this.pack = saveDescriptorPack(pack);
    this.relay?.updatePack(this.pack);
    return this.pack;
  }

  relayStatus() {
    return (
      this.relay?.status() ?? {
        connected: false,
        extensionVersion: 'n/a',
        packVersion: this.pack.version,
        lastSeenSecondsAgo: null,
        stale: false,
      }
    );
  }

  relayPairingToken(): string {
    return relayToken();
  }

  setAutomationDisabled(disabled: boolean): void {
    automationPolicy.setDisabled(disabled, 'user');
    this.rebuildAdapters();
  }

  /**
   * A crashed or closed run must be resumable, replayable or exportable.
   * On boot we surface anything left mid-flight rather than
   * silently leaving it as "running" forever.
   */
  private reportInterruptedRuns(): void {
    const stuck = this.store.findResumable();
    if (!stuck.length) return;
    log.warn(
      `${stuck.length} run(s) were interrupted by a previous shutdown and are marked resumable: ${stuck.join(', ')}`,
    );
  }

  version(): string {
    return ENGINE_VERSION;
  }

  async close(): Promise<void> {
    // Dispose transports before the store: a CDP seat may still be holding a
    // browser socket, and a desktop seat a driver process we started.
    await Promise.allSettled([...this.adapters.values()].map((a) => a.dispose?.()));
    this.adapters.clear();
    this.store.close();
  }

  /**
   * Approve a newly-added desktop app for automation.
   *
   * Mirrors Hermes's confirm-before-first-send guardrail: a desktop seat
   * refuses to act until the user has explicitly said yes to that application.
   */
  confirmDesktopSeat(seatId: string): boolean {
    const adapter = this.adapters.get(seatId);
    const target =
      adapter instanceof FailoverAdapter
        ? adapter.chainMembers().find((a) => a instanceof DesktopAdapter)
        : adapter;

    if (!(target instanceof DesktopAdapter)) return false;
    target.confirmAutomation();
    audit.record({
      actor: 'user',
      seatId,
      action: 'desktop.confirmed',
      detail: 'user approved this application for automation',
      ok: true,
    });
    return true;
  }
}
