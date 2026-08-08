import { useEffect, useMemo, useState } from 'react';

import type {
  PreflightEstimate,
  RunMode,
  RunRecord,
  RunSettings,
  SeatConfig,
  SeatHealth,
  Stubbornness,
} from '@consensus/shared';
import { STUBBORNNESS_LABELS } from '@consensus/shared';

import { api } from '../api.js';
import { ReportPanel } from './ReportPanel.js';

interface Props {
  seats: SeatConfig[];
  health: SeatHealth[];
  run: RunRecord | null;
  streaming: Record<string, string>;
  awaiting: Record<string, string> | null;
  onSeatsChanged: () => void;
  onRunStarted: (run: RunRecord) => void;
}

export function RunView({ seats, health, run, streaming, awaiting, onSeatsChanged, onRunStarted }: Props) {
  const [prompt, setPrompt] = useState('');
  const [settings, setSettings] = useState<RunSettings | null>(null);
  const [estimate, setEstimate] = useState<PreflightEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.settings().then(setSettings);
  }, []);

  useEffect(() => {
    if (!settings) return;
    void api.preflight(settings).then(setEstimate).catch(() => setEstimate(null));
  }, [settings, seats]);

  const enabled = seats.filter((s) => s.enabled);
  const healthById = useMemo(() => new Map(health.map((h) => [h.seatId, h])), [health]);

  const toggleSeat = async (id: string) => {
    const next = seats.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s));
    await api.saveSeats(next);
    onSeatsChanged();
  };

  const makePrimary = async (id: string) => {
    const next = seats.map((s) => ({ ...s, primary: s.id === id }));
    await api.saveSeats(next);
    onSeatsChanged();
  };

  const start = async () => {
    if (!prompt.trim() || !settings) return;
    setBusy(true);
    setError(null);
    try {
      onRunStarted(await api.startRun(prompt, settings));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const patch = (p: Partial<RunSettings>) => setSettings((s) => (s ? { ...s, ...p } : s));

  return (
    <div className="stack">
      {/* --------------------------------------------------- prompt bar --- */}
      <section className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          {seats.map((seat) => {
            const h = healthById.get(seat.id);
            return (
              <button
                key={seat.id}
                className="chip"
                data-on={seat.enabled}
                data-health={h?.status ?? 'dropped'}
                onClick={() => void toggleSeat(seat.id)}
                onDoubleClick={() => void makePrimary(seat.id)}
                title={`${h?.family ?? seat.adapter} · double-click to make primary${
                  h?.conformance ? ` · conformance ${h.conformance.ok ? 'green' : 'RED'}` : ''
                }`}
              >
                <span className="dot" />
                {seat.displayName}
                {seat.primary && <span className="star">★</span>}
                {h?.lossy && <span className="tag lossy">lossy</span>}
              </button>
            );
          })}
          {seats.length === 0 && <span className="faint">No seats configured — open the Transport tab.</span>}
        </div>

        <textarea
          rows={5}
          value={prompt}
          placeholder="Ask one question. It goes to every enabled model at once, and they cross-examine each other if they disagree."
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start();
          }}
        />

        {settings && (
          <div className="row" style={{ marginTop: 10 }}>
            <label className="row" style={{ gap: 6 }}>
              <span className="label">Mode</span>
              <select
                value={settings.mode}
                onChange={(e) => patch({ mode: e.target.value as RunMode })}
                style={{ width: 'auto' }}
              >
                <option value="auto">Auto</option>
                <option value="semi">Semi</option>
                <option value="manual">Manual</option>
              </select>
            </label>

            <label className="row" style={{ gap: 6 }}>
              <span className="label" title="The primary tunable of this system">
                Stubbornness
              </span>
              <select
                value={settings.stubbornness}
                onChange={(e) => patch({ stubbornness: Number(e.target.value) as Stubbornness })}
                style={{ width: 'auto' }}
              >
                {([0, 1, 2, 3, 4] as Stubbornness[]).map((level) => (
                  <option key={level} value={level}>
                    {level} — {STUBBORNNESS_LABELS[level]}
                  </option>
                ))}
              </select>
            </label>

            <label className="row" style={{ gap: 6 }}>
              <span className="label">Judge</span>
              <select
                value={settings.judge}
                onChange={(e) => patch({ judge: e.target.value as RunSettings['judge'] })}
                style={{ width: 'auto' }}
              >
                <option value="structured">Structured</option>
                <option value="embedding">Embedding (advisory)</option>
                <option value="llm">LLM judge</option>
                <option value="human">Human</option>
              </select>
            </label>

            <label className="row" style={{ gap: 6 }}>
              <span className="label">Max rounds</span>
              <input
                type="number"
                min={2}
                max={8}
                value={settings.maxRounds}
                onChange={(e) => patch({ maxRounds: Number(e.target.value) })}
                style={{ width: 64 }}
              />
            </label>

            <label className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={settings.forceDebate}
                onChange={(e) => patch({ forceDebate: e.target.checked })}
              />
              <span className="muted">Debate anyway</span>
            </label>

            <label
              className="row"
              style={{ gap: 6 }}
              title="Ask each seat the same question again at a higher temperature and check it agrees with itself. Costs one extra message per sample per seat."
            >
              <span className="label">Self-check</span>
              <select
                value={settings.selfConsistencySamples}
                onChange={(e) => patch({ selfConsistencySamples: Number(e.target.value) })}
                style={{ width: 'auto' }}
              >
                <option value={0}>off</option>
                <option value={1}>×1</option>
                <option value={2}>×2</option>
                <option value={3}>×3</option>
              </select>
            </label>

            <label
              className="row"
              style={{ gap: 6 }}
              title="After the panel agrees, have a seat that disagreed review the answer cold. One extra message."
            >
              <input
                type="checkbox"
                checked={settings.crossCheck}
                onChange={(e) => patch({ crossCheck: e.target.checked })}
              />
              <span className="muted">Cross-check</span>
            </label>

            <button className="btn primary" style={{ marginLeft: 'auto' }} disabled={busy || !enabled.length} onClick={() => void start()}>
              {busy ? 'Starting…' : 'Run  ⌘↵'}
            </button>
          </div>
        )}

        {estimate && enabled.length > 0 && (
          <p className="faint" style={{ marginBottom: 0, marginTop: 10, fontSize: 12 }}>
            About <strong>{estimate.messagesPerSeat}</strong> message(s) from each of{' '}
            <strong>{estimate.seats}</strong> seat(s) — roughly {estimate.expectedCalls} calls,{' '}
            {estimate.estimatedMinutes[0]}–{estimate.estimatedMinutes[1]} minutes. This is a background job,
            not a chat turn: start it and walk away.
            {estimate.warnings.map((w) => (
              <span key={w} style={{ display: 'block', color: 'var(--revised)' }}>
                {w}
              </span>
            ))}
          </p>
        )}

        {error && <p style={{ color: 'var(--overruled)' }}>{error}</p>}
      </section>

      {/* ------------------------------------------------ manual approval --- */}
      {awaiting && run && (
        <section className="card">
          <div className="spread">
            <h2>Waiting for your approval</h2>
            <div className="row">
              <button className="btn" onClick={() => void api.control(run.id, { kind: 'approve' })}>
                Send as written
              </button>
              <button className="btn danger" onClick={() => void api.control(run.id, { kind: 'abort' })}>
                Abort
              </button>
            </div>
          </div>
          <p className="faint">
            Every prompt is editable before it is sent. Edits apply to this round only.
          </p>
          {Object.entries(awaiting).map(([seatId, text]) => (
            <details key={seatId} style={{ marginTop: 8 }}>
              <summary className="mono">{seatId}</summary>
              <pre className="mono scrolly" style={{ whiteSpace: 'pre-wrap' }}>
                {text}
              </pre>
            </details>
          ))}
        </section>
      )}

      {run ? <RunDetail run={run} streaming={streaming} /> : <EmptyState />}
    </div>
  );
}

function EmptyState() {
  return (
    <section className="card">
      <p className="empty">
        No run yet. Ask a question above.
        <br />
        <span className="faint">
          Consensus is not correctness — models trained on overlapping data share errors, and four models can
          be confidently and identically wrong.
        </span>
      </p>
    </section>
  );
}

/* -------------------------------------------------------------- run detail */

function RunDetail({ run, streaming }: { run: RunRecord; streaming: Record<string, string> }) {
  const seatIds = run.seatIds;
  const consensus = run.rounds.at(-1)?.consensus ?? null;

  const bannerKind =
    run.outcome === 'converged'
      ? 'converged'
      : run.outcome === 'converged_contested'
        ? 'contested'
        : run.outcome
          ? 'unresolved'
          : 'contested';

  return (
    <>
      {/* --------------------------------------------- convergence banner --- */}
      <section className="banner" data-kind={bannerKind}>
        <div className="spread">
          <div>
            <div className="headline">{headline(run)}</div>
            <div className="caveat">
              {run.classification && (
                <>
                  Classified <strong>{run.classification.type}</strong> ({run.classification.rationale}).{' '}
                </>
              )}
              {run.status === 'running' && 'Running — this is a background job; you can leave the page.'}
              {(run.outcome === 'converged' || run.outcome === 'converged_contested') &&
                ' Convergence is not correctness.'}
            </div>
          </div>
          <div className="row">
            {run.status === 'running' && (
              <>
                <button className="btn small" onClick={() => void api.control(run.id, { kind: 'pause' })}>
                  Pause
                </button>
                <button className="btn small" onClick={() => void api.control(run.id, { kind: 'step' })}>
                  Step
                </button>
              </>
            )}
            {run.status === 'paused' && (
              <button className="btn small" onClick={() => void api.control(run.id, { kind: 'resume' })}>
                Resume
              </button>
            )}
            {run.status === 'running' && (
              <button className="btn small danger" onClick={() => void api.control(run.id, { kind: 'abort' })}>
                Abort
              </button>
            )}
            <a className="btn small" href={`/api/runs/${run.id}/report.md`} download>
              Export .md
            </a>
            <a className="btn small" href={`/api/runs/${run.id}/export`} download>
              Export .json
            </a>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------- round view --- */}
      <section className="card">
        <h2>Rounds</h2>
        <div
          className="grid"
          style={{ gridTemplateColumns: `56px repeat(${seatIds.length}, minmax(200px, 1fr))` }}
        >
          <div />
          {seatIds.map((id) => {
            const seat = run.seats[id];
            return (
              <div key={id} className="label" style={{ paddingBottom: 4 }}>
                {seat?.displayName}
                {run.primarySeatId === id && <span className="star"> ★</span>}
                <div className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  {seat?.family}
                </div>
              </div>
            );
          })}

          {run.rounds.map((round) => (
            <RoundRow key={round.round} run={run} round={round.round} streaming={streaming} />
          ))}
        </div>
      </section>

      {/* ------------------------------------------------ divergence panel --- */}
      {consensus && consensus.camps.length > 1 && (
        <section className="card">
          <h2>Divergence</h2>
          <p className="faint" style={{ marginTop: 0 }}>
            {consensus.detail ?? 'The panel holds more than one position. These are the competing claims.'}
          </p>
          <div className="camps">
            {consensus.camps.map((camp) => (
              <div key={camp.key} className="camp">
                <div className="claim">{camp.label || '(no key)'}</div>
                <div className="who">
                  {camp.seatIds.map((id) => run.seats[id]?.displayName ?? id).join(', ')} —{' '}
                  {camp.seatIds.length} of {seatIds.length}
                </div>
                <div className="answer">{camp.representativeAnswer}</div>
                <button
                  className="btn small"
                  style={{ marginTop: 8 }}
                  onClick={() => void navigator.clipboard.writeText(camp.representativeAnswer)}
                >
                  Copy raw
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---------------------------------------------------- final answer --- */}
      {run.finalAnswer && (
        <section className="card">
          <div className="spread">
            <h2>Answer</h2>
            <button className="btn small" onClick={() => void navigator.clipboard.writeText(run.finalAnswer!)}>
              Copy raw
            </button>
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{run.finalAnswer}</div>
        </section>
      )}

      {run.status === 'done' && <ReportPanel runId={run.id} />}
    </>
  );
}

function RoundRow({
  run,
  round,
  streaming,
}: {
  run: RunRecord;
  round: number;
  streaming: Record<string, string>;
}) {
  const record = run.rounds.find((r) => r.round === round);
  return (
    <>
      <div className="roundlabel">R{round}</div>
      {run.seatIds.map((seatId) => {
        const seat = run.seats[seatId];
        const letter = record?.letters[seatId];
        const critics = record?.critics[seatId] ?? [];
        const live = streaming[seatId];

        const state = seat?.droppedAtRound !== undefined && seat.droppedAtRound <= round
          ? 'withdrawn'
          : live
            ? 'running'
            : seat?.agreedRounds.includes(round)
              ? 'agreed'
              : critics.length > 0
                ? 'overruled'
                : round === run.rounds.length && run.status === 'running'
                  ? 'running'
                  : 'revised';

        return (
          <div key={seatId} className="cell" data-state={state}>
            <div className="head">
              {letter && <span className="tag">Expert {letter}</span>}
              <span className={`tag ${state}`}>{state}</span>
              {critics.length > 0 && (
                <span className="faint" style={{ fontSize: 11 }}>
                  {critics.length} objection{critics.length > 1 ? 's' : ''}
                </span>
              )}
            </div>
            <div className="body">
              {live ?? (round === run.rounds.length ? seat?.answer ?? '' : seat?.answerKey ?? '')}
            </div>
          </div>
        );
      })}
    </>
  );
}

function headline(run: RunRecord): string {
  const consensus = run.rounds.at(-1)?.consensus;
  const agreed = consensus?.camps[0]?.seatIds.length ?? 0;
  const total = run.seatIds.length;

  switch (run.outcome) {
    case 'converged':
      return `${agreed}/${total} models converged in ${run.stats.rounds} round${run.stats.rounds === 1 ? '' : 's'}`;
    case 'converged_contested':
      return `Converged, but contested — read the caveats`;
    case 'unresolved':
      return `Unresolved after ${run.stats.rounds} rounds — ${consensus?.camps.length ?? 2} camps`;
    case 'oscillating':
      return 'Stopped: the panel was cycling between the same positions';
    case 'quorum_lost':
      return 'Stopped: fewer than two models were left in the panel';
    case 'no_debate':
      return 'Answers side by side — this prompt has no single verifiable answer';
    case 'timeout':
      return 'Stopped: the run exceeded its time limit';
    case 'aborted':
      return 'Aborted';
    case 'error':
      return `Failed: ${run.error ?? 'unknown error'}`;
    default:
      return `Round ${run.stats.rounds || 1} — ${run.status}`;
  }
}
