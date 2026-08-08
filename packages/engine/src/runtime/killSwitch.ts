import { logger } from '../util/logger.js';
import { audit } from './audit.js';

const log = logger('killswitch');

/**
 * Global kill switch.
 *
 * One switch stops all automation immediately and falls the panel back to
 * non-UI seats, so a broken descriptor pack or a misbehaving driver can never
 * brick the app or keep acting inside the user's accounts. Engaging it aborts
 * every in-flight run and refuses new automation until it is released.
 */
class KillSwitch {
  private engaged = false;
  private controller = new AbortController();
  private listeners = new Set<(engaged: boolean) => void>();

  get isEngaged(): boolean {
    return this.engaged;
  }

  /** Aborts when the switch is engaged. Every model call links to this. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  subscribe(fn: (engaged: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  engage(by: string): void {
    if (this.engaged) return;
    this.engaged = true;
    this.controller.abort(new Error('kill switch engaged'));
    log.warn(`kill switch engaged by ${by}: all automation stopped`);
    audit.record({ actor: 'user', action: 'killswitch.engage', detail: by, ok: true });
    this.notify();
  }

  release(by: string): void {
    if (!this.engaged) return;
    this.engaged = false;
    this.controller = new AbortController();
    log.info(`kill switch released by ${by}`);
    audit.record({ actor: 'user', action: 'killswitch.release', detail: by, ok: true });
    this.notify();
  }

  /** Throws if automation is currently forbidden. Called before every UI-driven action. */
  assertClear(): void {
    if (this.engaged) throw new Error('automation is disabled: the kill switch is engaged');
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.engaged);
      } catch {
        /* ignore */
      }
    }
  }
}

export const killSwitch = new KillSwitch();

/**
 * "Disable all automation": a softer switch than the kill switch.
 * It does not abort in-flight work; it makes the orchestrator refuse to seat
 * relay and desktop adapters, so the panel falls back to CLI/local/API seats.
 */
class AutomationPolicy {
  private disabled = false;

  get uiAutomationDisabled(): boolean {
    return this.disabled;
  }

  setDisabled(value: boolean, by: string): void {
    this.disabled = value;
    log.info(`UI automation ${value ? 'disabled' : 'enabled'} by ${by}`);
    audit.record({
      actor: 'user',
      action: value ? 'automation.disable' : 'automation.enable',
      detail: by,
      ok: true,
    });
  }
}

export const automationPolicy = new AutomationPolicy();
