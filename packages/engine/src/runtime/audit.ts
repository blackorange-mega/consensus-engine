import type { AuditActor, AuditEntry } from '@consensus/shared';

import { sha256 } from '../util/hash.js';

/**
 * The automation activity log.
 *
 * If the app is clicking inside the user's logged-in accounts, they must be
 * able to watch it. Every action the relay and the desktop drivers take lands
 * here, and the log is hash-chained: each entry commits to the previous one, so
 * a gap or an edit is detectable rather than silent. That matters precisely
 * because this log is the user's only evidence of what was done in their name.
 */

const GENESIS = '0'.repeat(64);

export type AuditListener = (entry: AuditEntry) => void;

export class AuditLog {
  private entries: AuditEntry[] = [];
  private listeners = new Set<AuditListener>();
  private seq = 0;
  private prevHash = GENESIS;

  constructor(private readonly capacity = 5_000) {}

  subscribe(fn: AuditListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  record(input: {
    actor: AuditActor;
    action: string;
    ok: boolean;
    seatId?: string;
    runId?: string;
    target?: string;
    detail?: string;
  }): AuditEntry {
    const seq = ++this.seq;
    const at = Date.now();

    const canonical = JSON.stringify([
      seq,
      at,
      input.actor,
      input.seatId ?? '',
      input.runId ?? '',
      input.action,
      input.target ?? '',
      input.detail ?? '',
      input.ok,
    ]);

    const entry: AuditEntry = {
      seq,
      at,
      actor: input.actor,
      seatId: input.seatId,
      runId: input.runId,
      action: input.action,
      target: input.target,
      detail: input.detail,
      ok: input.ok,
      prevHash: this.prevHash,
      hash: sha256(this.prevHash + canonical),
    };

    this.prevHash = entry.hash;
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();

    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        /* a broken listener must never break the audit trail */
      }
    }
    return entry;
  }

  recent(limit = 200, runId?: string): AuditEntry[] {
    const source = runId ? this.entries.filter((e) => e.runId === runId) : this.entries;
    return source.slice(-limit);
  }

  /** Re-derive the chain and report the first entry that does not check out. */
  verify(): { ok: boolean; brokenAtSeq?: number } {
    let prev = this.entries[0]?.prevHash ?? GENESIS;
    for (const e of this.entries) {
      const canonical = JSON.stringify([
        e.seq,
        e.at,
        e.actor,
        e.seatId ?? '',
        e.runId ?? '',
        e.action,
        e.target ?? '',
        e.detail ?? '',
        e.ok,
      ]);
      if (e.prevHash !== prev || e.hash !== sha256(prev + canonical)) {
        return { ok: false, brokenAtSeq: e.seq };
      }
      prev = e.hash;
    }
    return { ok: true };
  }
}

export const audit = new AuditLog();
