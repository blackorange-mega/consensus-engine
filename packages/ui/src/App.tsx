import { useCallback, useEffect, useState } from 'react';

import type { AuditEntry, EngineEvent, RunRecord, SeatConfig, SeatHealth } from '@consensus/shared';

import { api, useEngineEvents, type RelayStatus } from './api.js';
import { ActivityView } from './views/ActivityView.js';
import { RunView } from './views/RunView.js';
import { ScoreboardView } from './views/ScoreboardView.js';
import { SeatsView } from './views/SeatsView.js';
import { TemplatesView } from './views/TemplatesView.js';

type Tab = 'run' | 'seats' | 'scoreboard' | 'activity' | 'templates';

const TABS: Array<{ id: Tab; label: string; key: string }> = [
  { id: 'run', label: 'Run', key: '1' },
  { id: 'seats', label: 'Transport', key: '2' },
  { id: 'scoreboard', label: 'Scoreboard', key: '3' },
  { id: 'activity', label: 'Activity', key: '4' },
  { id: 'templates', label: 'Prompts', key: '5' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('run');
  const [seats, setSeats] = useState<SeatConfig[]>([]);
  const [health, setHealth] = useState<SeatHealth[]>([]);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [killed, setKilled] = useState(false);
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [awaiting, setAwaiting] = useState<Record<string, string> | null>(null);

  const refreshSeats = useCallback(async () => {
    const res = await api.seats();
    setSeats(res.seats);
    setHealth(res.health);
  }, []);

  useEffect(() => {
    void refreshSeats();
    void api.health().then((h) => {
      setKilled(h.killSwitch);
      setRelay(h.relay);
    });
    void api.audit(200).then((a) => setAudit(a.entries));
  }, [refreshSeats]);

  const onEvent = useCallback((event: EngineEvent) => {
    switch (event.type) {
      case 'run:created':
        setRun(event.run);
        setStreaming({});
        setAwaiting(null);
        break;
      case 'run:done':
        setRun(event.run);
        setStreaming({});
        setAwaiting(null);
        break;
      case 'run:status':
      case 'run:classified':
      case 'round:start':
      case 'round:end':
      case 'turn:end':
        // Re-read the authoritative record rather than patching it locally:
        // the engine is the single source of truth for run state.
        setRun((current) => {
          if (!current) return current;
          void api.run(current.id).then(setRun).catch(() => undefined);
          return current;
        });
        if (event.type === 'turn:end') {
          setStreaming((s) => {
            const next = { ...s };
            delete next[event.turn.seatId];
            return next;
          });
        }
        break;
      case 'turn:delta':
        setStreaming((s) => ({ ...s, [event.seatId]: (s[event.seatId] ?? '') + event.delta }));
        break;
      case 'run:awaiting':
        setAwaiting(event.prompts);
        break;
      case 'seat:health':
        setHealth(event.health);
        break;
      case 'audit':
        setAudit((a) => [...a.slice(-400), event.entry]);
        break;
      case 'killswitch':
        setKilled(event.engaged);
        break;
      default:
        break;
    }
  }, []);

  const { connected } = useEngineEvents(onEvent);

  // Keyboard-driven.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (typing && !(e.metaKey || e.ctrlKey)) return;

      const hit = TABS.find((t) => t.key === e.key);
      if (hit && (e.altKey || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setTab(hit.id);
      }
      if (e.key === 'Escape' && killed === false && e.shiftKey) {
        e.preventDefault();
        void api.killSwitch(true).then(() => setKilled(true));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [killed]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Consensus Engine
          <span>{connected ? 'live' : 'reconnecting…'}</span>
        </div>

        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              className="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              <kbd>⌥{t.key}</kbd>
            </button>
          ))}
        </nav>

        <button
          className={`btn small ${killed ? 'primary' : 'danger'}`}
          onClick={() => void api.killSwitch(!killed).then(() => setKilled(!killed))}
          title="Stops all automation immediately and falls the panel back to non-UI seats"
        >
          {killed ? 'Release kill switch' : 'Kill switch'}
        </button>
      </header>

      {killed && (
        <div className="killbar">
          <strong>Automation stopped.</strong> No relay or desktop action will run, and in-flight runs were
          aborted. CLI, local and API seats are unaffected.
        </div>
      )}

      <main className="main">
        <div className="pane">
          {tab === 'run' && (
            <RunView
              seats={seats}
              health={health}
              run={run}
              streaming={streaming}
              awaiting={awaiting}
              onSeatsChanged={refreshSeats}
              onRunStarted={setRun}
            />
          )}
          {tab === 'seats' && (
            <SeatsView seats={seats} health={health} relay={relay} onChanged={refreshSeats} />
          )}
          {tab === 'scoreboard' && <ScoreboardView />}
          {tab === 'activity' && <ActivityView entries={audit} />}
          {tab === 'templates' && <TemplatesView />}
        </div>
      </main>
    </div>
  );
}
