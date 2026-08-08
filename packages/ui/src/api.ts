import { useEffect, useRef, useState } from 'react';

import type {
  AuditEntry,
  ConformanceResult,
  EngineEvent,
  PreflightEstimate,
  RunControl,
  RunRecord,
  RunSettings,
  ScoreboardEntry,
  SeatConfig,
  SeatHealth,
  VerificationReport,
} from '@consensus/shared';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => call<{ ok: boolean; version: string; killSwitch: boolean; relay: RelayStatus }>('/api/health'),

  seats: () => call<{ seats: SeatConfig[]; health: SeatHealth[] }>('/api/seats'),
  saveSeats: (seats: SeatConfig[]) =>
    call<{ seats: SeatConfig[] }>('/api/seats', { method: 'PUT', body: JSON.stringify({ seats }) }),
  discover: () => call<{ found: Discovered[]; suggestion: { seats: SeatConfig[]; warnings: string[] } }>(
    '/api/seats/discover',
    { method: 'POST' },
  ),
  conformance: (seatId: string) =>
    call<ConformanceResult>(`/api/seats/${encodeURIComponent(seatId)}/conformance`, { method: 'POST' }),

  settings: () => call<RunSettings>('/api/settings'),
  saveSettings: (patch: Partial<RunSettings>) =>
    call<RunSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  preflight: (settings: Partial<RunSettings>) =>
    call<PreflightEstimate>('/api/preflight', { method: 'POST', body: JSON.stringify({ settings }) }),

  startRun: (prompt: string, settings: Partial<RunSettings>) =>
    call<RunRecord>('/api/runs', { method: 'POST', body: JSON.stringify({ prompt, settings }) }),
  runs: () => call<{ runs: RunSummary[] }>('/api/runs'),
  run: (id: string) => call<RunRecord>(`/api/runs/${encodeURIComponent(id)}`),
  control: (id: string, cmd: RunControl) =>
    call<{ ok: boolean }>(`/api/runs/${encodeURIComponent(id)}/control`, {
      method: 'POST',
      body: JSON.stringify(cmd),
    }),
  report: (id: string) => call<Report>(`/api/runs/${encodeURIComponent(id)}/report`),

  scoreboard: () => call<{ entries: ScoreboardEntry[] }>('/api/scoreboard'),
  templates: () => call<{ templates: Template[] }>('/api/templates'),
  saveTemplate: (id: string, body: string) =>
    call<Template>(`/api/templates/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ body }) }),

  audit: (limit = 200) =>
    call<{ entries: AuditEntry[]; chain: { ok: boolean; brokenAtSeq?: number } }>(`/api/audit?limit=${limit}`),

  killSwitch: (engaged: boolean) =>
    call<{ engaged: boolean }>('/api/killswitch', { method: 'POST', body: JSON.stringify({ engaged }) }),
  automation: (disabled: boolean) =>
    call<{ disabled: boolean }>('/api/automation', { method: 'POST', body: JSON.stringify({ disabled }) }),
  relayToken: () => call<{ token: string; url: string }>('/api/relay/token'),
};

export interface RelayStatus {
  connected: boolean;
  extensionVersion: string;
  packVersion: string;
}

export interface Discovered {
  seat: SeatConfig;
  detail: string;
  unmetered: boolean;
}

export interface RunSummary {
  id: string;
  title: string;
  createdAt: number;
  status: RunRecord['status'];
  outcome: RunRecord['outcome'];
}

export interface Template {
  id: string;
  description: string;
  body: string;
  customised: boolean;
  variables: string[];
}

export interface Report {
  runId: string;
  headline: string;
  outcome: RunRecord['outcome'];
  finalAnswer: string | null;
  finalAnswerKey: string | null;
  taskType: string | null;
  settings: { mode: string; stubbornness: string; judge: string; maxRounds: number };
  timeline: Array<{
    round: number;
    displayName: string;
    letter: string;
    kind: string;
    verdict: string;
    answerKey: string;
    latencyMs: number;
    failure?: string;
    lossy?: boolean;
  }>;
  seats: Array<{
    seatId: string;
    displayName: string;
    transport: string;
    firstAnswerKey: string | null;
    finalAnswerKey: string | null;
    changedItsMind: boolean;
    flips: number;
    agreedInRounds: number[];
    status: string;
    withdrewAtRound?: number;
    withdrawReason?: string;
    messagesUsed: number;
    lossy: boolean;
  }>;
  camps: Array<{ label: string; seats: string[]; answer: string }>;
  disagreement: string | null;
  confidence: {
    roundsToConvergence: number | null;
    unanimous: boolean;
    quorumAtEnd: number;
    panelStartedAt: number;
    proseSpread?: number;
    flipTotal: number;
  };
  cost: { calls: number; failedCalls: number; tokensIn: number; tokensOut: number; costUsd: number; wallMs: number };
  caveats: string[];
  verification: VerificationReport | null;
}

/**
 * Live engine telemetry. A run is a 2-8 minute background job,
 * so the UI is a monitor for work already in flight, not a request/response
 * chat loop.
 */
export function useEngineEvents(onEvent: (event: EngineEvent) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let closed = false;
    let delay = 500;

    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/ws`);

      socket.onopen = () => {
        delay = 500;
        setConnected(true);
      };
      socket.onmessage = (event) => {
        try {
          handler.current(JSON.parse(event.data) as EngineEvent);
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        delay = Math.min(delay * 2, 10_000);
        retry = window.setTimeout(open, delay);
      };
      socket.onerror = () => socket?.close();
    };

    open();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return { connected };
}

export function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}
