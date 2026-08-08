import { useState } from 'react';

import type { ConformanceResult, SeatConfig, SeatHealth } from '@consensus/shared';

import { api, type Discovered, type RelayStatus } from '../api.js';

interface Props {
  seats: SeatConfig[];
  health: SeatHealth[];
  relay: RelayStatus | null;
  onChanged: () => void;
}

/**
 * The transport health strip.
 *
 * Per seat: which family it uses, a red/amber/green conformance chip from the
 * smoke test, quota state, and a re-heal button. When a seat
 * degrades mid-run, this is where the user finds out why.
 */
export function SeatsView({ seats, health, relay, onChanged }: Props) {
  const [discovered, setDiscovered] = useState<Discovered[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [conformance, setConformance] = useState<Record<string, ConformanceResult>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [token, setToken] = useState<{ token: string; url: string } | null>(null);
  const [automationOff, setAutomationOff] = useState(false);

  const byId = new Map(health.map((h) => [h.seatId, h]));

  const discover = async () => {
    const res = await api.discover();
    setDiscovered(res.found);
    setWarnings(res.suggestion.warnings);
  };

  const addSeat = async (seat: SeatConfig) => {
    const next = seats.some((s) => s.id === seat.id)
      ? seats.map((s) => (s.id === seat.id ? { ...seat, enabled: true } : s))
      : [...seats, { ...seat, enabled: true }];
    await api.saveSeats(next);
    onChanged();
  };

  const runConformance = async (seatId: string) => {
    setRunning(seatId);
    try {
      const result = await api.conformance(seatId);
      setConformance((c) => ({ ...c, [seatId]: result }));
    } catch (err) {
      setConformance((c) => ({
        ...c,
        [seatId]: { ok: false, at: Date.now(), checks: [{ name: 'conformance', ok: false, detail: String(err) }] },
      }));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <div className="spread">
          <h2>Panel</h2>
          <div className="row">
            <label className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={automationOff}
                onChange={(e) => {
                  setAutomationOff(e.target.checked);
                  void api.automation(e.target.checked).then(onChanged);
                }}
              />
              <span className="muted">Disable all UI automation</span>
            </label>
            <button className="btn small" onClick={() => void discover()}>
              Re-scan this machine
            </button>
          </div>
        </div>

        <p className="faint" style={{ marginTop: 0 }}>
          A run mixes transports by design: Claude over CLI, ChatGPT over the browser relay, a local model
          over Ollama. Turning off UI automation falls the panel back to CLI, local and API seats, so a broken
          descriptor pack never bricks the app.
        </p>

        <table>
          <thead>
            <tr>
              <th>Seat</th>
              <th>Family</th>
              <th>Health</th>
              <th>Conformance</th>
              <th>Quota</th>
              <th>Capabilities</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {seats.map((seat) => {
              const h = byId.get(seat.id);
              const c = conformance[seat.id] ?? h?.conformance ?? null;
              return (
                <tr key={seat.id}>
                  <td>
                    <label className="row" style={{ gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={seat.enabled}
                        onChange={async () => {
                          await api.saveSeats(
                            seats.map((s) => (s.id === seat.id ? { ...s, enabled: !s.enabled } : s)),
                          );
                          onChanged();
                        }}
                      />
                      <span>
                        {seat.displayName}
                        {seat.primary && <span className="star"> ★</span>}
                      </span>
                    </label>
                    <div className="faint mono">{seat.id}</div>
                  </td>
                  <td className="faint">{h?.family ?? seat.adapter}</td>
                  <td>
                    <span className={`tag ${h?.status === 'healthy' ? 'agreed' : h?.status === 'degraded' ? 'revised' : 'overruled'}`}>
                      {h?.status ?? 'unknown'}
                    </span>
                    {h?.lastFailure?.detail && <div className="faint">{h.lastFailure.detail.slice(0, 80)}</div>}
                  </td>
                  <td>
                    {c ? (
                      <details>
                        <summary>
                          <span className={`tag ${c.ok ? 'agreed' : 'overruled'}`}>{c.ok ? 'green' : 'RED'}</span>
                        </summary>
                        <div className="faint" style={{ marginTop: 4 }}>
                          {c.checks.map((check) => (
                            <div key={check.name}>
                              {check.ok ? '✓' : '✗'} {check.name}
                              {check.detail ? ` — ${check.detail.slice(0, 90)}` : ''}
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : (
                      <span className="faint">not run</span>
                    )}
                  </td>
                  <td className="faint">
                    {h ? `${h.usage.run} this run · ${h.usage.day} today` : '—'}
                    {h?.quotaHint && <div>{h.quotaHint}</div>}
                  </td>
                  <td className="faint" style={{ fontSize: 11 }}>
                    {h &&
                      Object.entries(h.capabilities)
                        .filter(([, v]) => v)
                        .map(([k]) => k)
                        .join(', ')}
                  </td>
                  <td>
                    <button
                      className="btn small"
                      disabled={running === seat.id}
                      onClick={() => void runConformance(seat.id)}
                    >
                      {running === seat.id ? 'testing…' : 'Test'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Browser relay</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Status: <strong>{relay?.connected ? 'connected' : 'not connected'}</strong> · extension{' '}
          {relay?.extensionVersion ?? 'n/a'} · descriptor pack {relay?.packVersion ?? 'n/a'}
        </p>
        <p className="faint">
          Load <span className="mono">packages/extension</span> as an unpacked extension, then paste the
          pairing token below into its popup. The relay connects only to 127.0.0.1 and only acts on the
          provider origins the descriptor pack declares.
        </p>
        <div className="row">
          <button className="btn small" onClick={() => void api.relayToken().then(setToken)}>
            Show pairing token
          </button>
          {token && (
            <>
              <code className="mono">{token.url}</code>
              <code className="mono">{token.token}</code>
              <button
                className="btn small"
                onClick={() => void navigator.clipboard.writeText(token.token)}
              >
                Copy
              </button>
            </>
          )}
        </div>
      </section>

      {discovered && (
        <section className="card">
          <h2>Found on this machine</h2>
          {warnings.map((w) => (
            <p key={w} style={{ color: 'var(--revised)', marginTop: 0 }}>
              {w}
            </p>
          ))}
          <table>
            <thead>
              <tr>
                <th>Seat</th>
                <th>Detail</th>
                <th>Cost</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {discovered.map((d) => (
                <tr key={d.seat.id}>
                  <td>{d.seat.displayName}</td>
                  <td className="faint">{d.detail}</td>
                  <td>
                    <span className={`tag ${d.unmetered ? 'agreed' : 'revised'}`}>
                      {d.unmetered ? 'unmetered' : 'metered'}
                    </span>
                  </td>
                  <td>
                    <button className="btn small" onClick={() => void addSeat(d.seat)}>
                      {seats.some((s) => s.id === d.seat.id) ? 'Enable' : 'Add'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
