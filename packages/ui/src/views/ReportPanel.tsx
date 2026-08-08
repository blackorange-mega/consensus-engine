import { useEffect, useState } from 'react';

import { api, type Report } from '../api.js';

/**
 * The run report: who was wrong initially, who corrected whom,
 * who flipped, who withdrew — plus the caveats that stop a converged answer
 * from being read as a correct one.
 */
export function ReportPanel({ runId }: { runId: string }) {
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    void api.report(runId).then(setReport).catch(() => setReport(null));
  }, [runId]);

  if (!report) return null;

  return (
    <>
      {report.verification && (
        <section className="card">
          <div className="spread">
            <h2>Verification</h2>
            <span className={`tag ${report.verification.band === 'high' ? 'agreed' : report.verification.band === 'moderate' ? 'revised' : 'overruled'}`}>
              {(report.verification.confidence * 100).toFixed(0)}% · {report.verification.band}
            </span>
          </div>

          <p className="muted" style={{ marginTop: 0 }}>{report.verification.summary}</p>

          <table>
            <thead>
              <tr>
                <th>Factor</th>
                <th className="num">Effect</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {report.verification.factors.map((f) => (
                <tr key={f.name}>
                  <td>{f.name}</td>
                  <td
                    className="num"
                    style={{ color: f.contribution >= 0 ? 'var(--agreed)' : 'var(--overruled)' }}
                  >
                    {f.contribution >= 0 ? '+' : ''}
                    {(f.contribution * 100).toFixed(1)}
                  </td>
                  <td className="faint">{f.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {report.verification.perSeat.length > 0 && (
            <>
              <h3>Self-consistency on resampling</h3>
              <div className="row">
                {report.verification.perSeat.map((s) => (
                  <span key={s.seatId} className={`tag ${s.selfConsistent ? 'agreed' : 'overruled'}`}>
                    {s.seatId} {(s.agreementRate * 100).toFixed(0)}%
                  </span>
                ))}
              </div>
            </>
          )}

          {report.verification.crossCheck && (
            <>
              <h3>Cross-check</h3>
              <p className="muted" style={{ margin: 0 }}>
                <strong>{report.verification.crossCheck.verifierSeatId}</strong>
                {report.verification.crossCheck.wasDissenter && ', which had disagreed,'}{' '}
                {report.verification.crossCheck.agrees ? 'accepted' : 'rejected'} the agreed answer
                {report.verification.crossCheck.objection && `: ${report.verification.crossCheck.objection}`}
              </p>
            </>
          )}

          <p className="faint" style={{ marginBottom: 0 }}>
            This score measures how the panel behaved — independence, consistency, whether anyone folded.
            It is not a probability that the answer is true.
          </p>
        </section>
      )}

      {report.caveats.length > 0 && (
        <section className="card">
          <h2>Read this before acting on the answer</h2>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
            {report.caveats.map((c) => (
              <li key={c} style={{ marginBottom: 4 }}>
                {c}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Panel</h2>
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Transport</th>
              <th>Round 1</th>
              <th>Final</th>
              <th className="num">Flips</th>
              <th>Agreed in</th>
              <th>Status</th>
              <th className="num">Msgs</th>
            </tr>
          </thead>
          <tbody>
            {report.seats.map((s) => (
              <tr key={s.seatId}>
                <td>
                  {s.displayName} {s.lossy && <span className="tag lossy">lossy</span>}
                </td>
                <td className="faint">{s.transport}</td>
                <td className="mono">{s.firstAnswerKey ?? '—'}</td>
                <td className="mono">
                  {s.finalAnswerKey ?? '—'}
                  {s.changedItsMind && <span className="tag revised" style={{ marginLeft: 6 }}>changed</span>}
                </td>
                <td className="num">{s.flips}</td>
                <td className="faint">{s.agreedInRounds.join(', ') || '—'}</td>
                <td>
                  <span className={`tag ${s.status === 'dropped' ? 'withdrawn' : 'agreed'}`}>
                    {s.status}
                    {s.withdrewAtRound ? ` @R${s.withdrewAtRound}` : ''}
                  </span>
                  {s.withdrawReason && <div className="faint">{s.withdrawReason}</div>}
                </td>
                <td className="num">{s.messagesUsed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="spread">
          <h2>Timeline</h2>
          <span className="faint">
            {report.cost.calls} calls · {report.cost.failedCalls} failed ·{' '}
            {(report.cost.wallMs / 1000).toFixed(1)}s · {report.cost.tokensIn}/{report.cost.tokensOut} tokens
            {report.cost.costUsd > 0 && ` · $${report.cost.costUsd.toFixed(4)}`}
          </span>
        </div>
        <div className="scrolly">
          <table>
            <thead>
              <tr>
                <th>R</th>
                <th>Model</th>
                <th>Expert</th>
                <th>Step</th>
                <th>Verdict</th>
                <th>Key</th>
                <th className="num">Latency</th>
              </tr>
            </thead>
            <tbody>
              {report.timeline.map((t, i) => (
                <tr key={i}>
                  <td className="faint">{t.round}</td>
                  <td>{t.displayName}</td>
                  <td className="faint">{t.letter}</td>
                  <td className="faint">{t.kind}</td>
                  <td>
                    {t.failure ? (
                      <span className="tag overruled">{t.failure.slice(0, 40)}</span>
                    ) : (
                      <span className={`tag ${t.verdict === 'agree' ? 'agreed' : 'revised'}`}>{t.verdict}</span>
                    )}
                  </td>
                  <td className="mono">{t.answerKey.slice(0, 40) || '—'}</td>
                  <td className="num">{(t.latencyMs / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Confidence signals</h2>
        <div className="row" style={{ gap: 20 }}>
          <Stat
            label="Rounds to convergence"
            value={report.confidence.roundsToConvergence?.toString() ?? 'did not converge'}
          />
          <Stat label="Unanimous" value={report.confidence.unanimous ? 'yes' : 'no'} />
          <Stat
            label="Panel size"
            value={`${report.confidence.panelStartedAt} → ${report.confidence.quorumAtEnd}`}
          />
          <Stat label="Position changes" value={String(report.confidence.flipTotal)} />
          {report.confidence.proseSpread !== undefined && (
            <Stat label="Prose spread (advisory)" value={report.confidence.proseSpread.toFixed(2)} />
          )}
          <Stat label="Agreement modulation" value={report.settings.stubbornness} />
        </div>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
