import { useEffect, useState } from 'react';

import type { AuditEntry } from '@consensus/shared';

import { api } from '../api.js';

/**
 * The automation activity log.
 *
 * Non-negotiable: if the app is clicking inside the user's logged-in accounts,
 * they must be able to watch it. The chain check is shown because the log is
 * hash-chained — a gap or an edit is detectable rather than silent.
 */
export function ActivityView({ entries }: { entries: AuditEntry[] }) {
  const [chain, setChain] = useState<{ ok: boolean; brokenAtSeq?: number } | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void api.audit(400).then((r) => setChain(r.chain));
  }, [entries.length]);

  const visible = filter
    ? entries.filter((e) =>
        `${e.actor} ${e.action} ${e.target ?? ''} ${e.detail ?? ''}`.toLowerCase().includes(filter.toLowerCase()),
      )
    : entries;

  return (
    <section className="card">
      <div className="spread">
        <h2>Automation activity</h2>
        <div className="row">
          {chain && (
            <span className={`tag ${chain.ok ? 'agreed' : 'overruled'}`}>
              {chain.ok ? 'chain intact' : `chain broken at #${chain.brokenAtSeq}`}
            </span>
          )}
          <input
            type="text"
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: 180 }}
          />
        </div>
      </div>

      <p className="faint" style={{ marginTop: 0 }}>
        Every action the engine, the browser relay and the desktop drivers take, in order. Entries are
        hash-chained: each one commits to the previous, so tampering shows up as a broken chain.
      </p>

      <div className="log">
        {visible.length === 0 && <div className="empty">Nothing recorded yet.</div>}
        {visible
          .slice()
          .reverse()
          .map((e) => (
            <div key={e.seq} className="entry" data-ok={e.ok}>
              <span className="at">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="actor">{e.actor}</span>
              <span>
                {e.action}
                {e.seatId && <span className="faint"> · {e.seatId}</span>}
                {e.target && <span className="faint"> · {e.target}</span>}
                {e.detail && <span className="faint"> — {e.detail}</span>}
              </span>
            </div>
          ))}
      </div>
    </section>
  );
}
