import { useEffect, useState } from 'react';

import type { ScoreboardEntry } from '@consensus/shared';

import { api, relativeTime } from '../api.js';

/**
 * The lifetime scoreboard — built from the user's own
 * questions over time. "Gemini has been overruled 14 times in 60 runs" is the
 * kind of thing no other council tool tells you.
 *
 * The honest caveat is stated on screen: the converged answer is the only
 * ground truth available, so these are agreement statistics, not an accuracy
 * benchmark.
 */
export function ScoreboardView() {
  const [entries, setEntries] = useState<ScoreboardEntry[]>([]);

  useEffect(() => {
    void api.scoreboard().then((r) => setEntries(r.entries));
  }, []);

  if (!entries.length) {
    return (
      <section className="card">
        <p className="empty">
          No completed runs yet.
          <br />
          <span className="faint">
            The scoreboard fills in as you use the app: which model was right first, who got overruled, and
            who keeps folding under pressure.
          </span>
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Lifetime scoreboard</h2>
      <p className="faint" style={{ marginTop: 0 }}>
        Measured against what the panel converged on, which is the only ground truth available here. Read it
        as a record of agreement, not of correctness — if the panel is reliably wrong about something, this
        table will be reliably wrong about it too.
      </p>

      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th className="num">Runs</th>
            <th className="num">Right first</th>
            <th className="num">Overruled</th>
            <th className="num">Flips</th>
            <th className="num" title="Gave the agreed answer in round 1, then abandoned it">
              Talked out of it
            </th>
            <th className="num">Withdrew</th>
            <th className="num">Malformed</th>
            <th className="num">Latency</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const rate = e.runs ? Math.round((e.correctFirst / e.runs) * 100) : 0;
            return (
              <tr key={e.seatId}>
                <td>{e.displayName}</td>
                <td className="num">{e.runs}</td>
                <td className="num">
                  {e.correctFirst}
                  <span className="faint"> ({rate}%)</span>
                </td>
                <td className="num">{e.overruled}</td>
                <td className="num">{e.flips}</td>
                <td className="num" style={{ color: e.talkedOutOfCorrect > 0 ? 'var(--revised)' : undefined }}>
                  {e.talkedOutOfCorrect}
                </td>
                <td className="num">{e.withdrawals}</td>
                <td className="num">{e.nonCompliant}</td>
                <td className="num faint">{(e.avgLatencyMs / 1000).toFixed(1)}s</td>
                <td className="faint">{relativeTime(e.lastSeen)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="faint" style={{ marginBottom: 0 }}>
        A high <strong>talked out of it</strong> count is the sycophancy signal — that model gave the agreed
        answer in round 1 and was argued out of it. Raise the stubbornness setting and see whether it holds.
      </p>
    </section>
  );
}
