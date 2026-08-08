import type { IncomingMessage, Server } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import type {
  DescriptorPack,
  ExtractionPath,
  RelayAction,
  RelayResponse,
  SeatFailureReason,
  SiteDescriptor,
} from '@consensus/shared';
import { validateDescriptor } from '@consensus/shared';

import type { RelayHub } from '../adapters/relay.js';
import { audit } from '../runtime/audit.js';
import { killSwitch } from '../runtime/killSwitch.js';
import { Mutex } from '../util/async.js';
import { id as makeId } from '../util/hash.js';
import { logger } from '../util/logger.js';

const log = logger('relay');

type RelayResult =
  | { ok: true; text: string; lossy: boolean; via: ExtractionPath }
  | { ok: false; reason: SeatFailureReason; detail?: string };

interface Pending {
  resolve: (result: RelayResult) => void;
  timer: NodeJS.Timeout;
  onDelta?: (text: string) => void;
}

/**
 * The relay hub — the extension-driven transport.
 *
 * The extension opens a WebSocket to this server and executes a fixed action
 * set inside the user's live, already-authenticated browser profile. No
 * separate login, no cookie extraction, no re-auth, no browser restart.
 *
 * Security boundary, enforced here rather than documented:
 *   - the socket binds to localhost only and rejects any non-loopback peer;
 *   - the extension must present the pairing token on connect;
 *   - actions are a closed union — there is no "run this JS" verb, so no model
 *     output can become a browser action;
 *   - descriptors restrict the extension to registered provider origins;
 *   - every action is written to the hash-chained audit log.
 */
export class RelayServer implements RelayHub {
  private wss: WebSocketServer;
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private pack: DescriptorPack;
  private extensionVersion = 'unknown';
  /** Last time the extension was heard from, via any message including pings. */
  private lastSeen = 0;

  /**
   * Parallel across providers, serial within a provider: four
   * different sites at once is fine; four concurrent conversations on the same
   * account is how you trip rate limits.
   */
  private providerLocks = new Map<string, Mutex>();

  constructor(
    server: Server,
    private readonly token: string,
    pack: DescriptorPack,
    private readonly onStateChange?: (connected: boolean) => void,
  ) {
    this.pack = pack;
    this.validatePack();

    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/relay') return;

      if (!isLoopback(req)) {
        log.warn(`refused a relay connection from a non-loopback address: ${req.socket.remoteAddress}`);
        socket.destroy();
        return;
      }
      if (url.searchParams.get('token') !== this.token) {
        log.warn('refused a relay connection with a bad pairing token');
        audit.record({ actor: 'engine', action: 'relay.auth_rejected', ok: false });
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
    });

    killSwitch.subscribe((engaged) => {
      if (engaged) this.broadcastKill();
    });
  }

  /* ------------------------------------------------------------- RelayHub */

  connected(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  descriptorFor(provider: string): SiteDescriptor | undefined {
    return this.pack.descriptors.find((d) => d.provider === provider);
  }

  async request(
    seatId: string,
    action: RelayAction,
    timeoutMs: number,
    onDelta?: (text: string) => void,
  ): Promise<RelayResult> {
    if (killSwitch.isEngaged) {
      return { ok: false, reason: 'aborted', detail: 'the kill switch is engaged' };
    }
    if (!this.connected()) {
      return { ok: false, reason: 'not_configured', detail: 'the relay extension is not connected' };
    }

    const provider = 'provider' in action ? action.provider : undefined;
    if (provider && !this.descriptorFor(provider)) {
      return { ok: false, reason: 'not_configured', detail: `no descriptor for provider "${provider}"` };
    }

    const lock = provider ? this.lockFor(provider) : null;
    const send = () => this.dispatch(seatId, action, timeoutMs, onDelta);
    return lock ? lock.run(send) : send();
  }

  /* --------------------------------------------------------------- plumbing */

  updatePack(pack: DescriptorPack): void {
    this.pack = pack;
    this.validatePack();
    this.socket?.send(JSON.stringify({ type: 'hello', token: this.token, descriptorPack: pack }));
    log.info(`descriptor pack ${pack.version} pushed to the extension`);
  }

  status(): {
    connected: boolean;
    extensionVersion: string;
    packVersion: string;
    /** Seconds since the extension was last heard from, via any message. */
    lastSeenSecondsAgo: number | null;
    /**
     * The socket is open but the extension has gone quiet for longer than two
     * keepalive intervals. Usually means the browser suspended the offscreen
     * document; surfaced so a stalled relay looks stalled rather than healthy.
     */
    stale: boolean;
  } {
    const idleMs = this.lastSeen ? Date.now() - this.lastSeen : null;
    return {
      connected: this.connected(),
      extensionVersion: this.extensionVersion,
      packVersion: this.pack.version,
      lastSeenSecondsAgo: idleMs === null ? null : Math.round(idleMs / 1000),
      stale: this.connected() && idleMs !== null && idleMs > 60_000,
    };
  }

  private lockFor(provider: string): Mutex {
    let lock = this.providerLocks.get(provider);
    if (!lock) {
      lock = new Mutex();
      this.providerLocks.set(provider, lock);
    }
    return lock;
  }

  private dispatch(
    seatId: string,
    action: RelayAction,
    timeoutMs: number,
    onDelta?: (text: string) => void,
  ): Promise<RelayResult> {
    const id = makeId('act');

    return new Promise<RelayResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        audit.record({
          actor: 'relay',
          seatId,
          action: `relay.${action.kind}`,
          detail: `timed out after ${timeoutMs}ms`,
          ok: false,
        });
        resolve({ ok: false, reason: 'timeout', detail: `relay did not answer in ${timeoutMs}ms` });
      }, timeoutMs);

      this.pending.set(id, { resolve, timer, onDelta });

      this.socket?.send(JSON.stringify({ type: 'action', id, seatId, action }));

      audit.record({
        actor: 'relay',
        seatId,
        action: `relay.${action.kind}`,
        target: 'provider' in action ? action.provider : undefined,
        detail: action.kind === 'send' ? `${action.text.length} chars` : undefined,
        ok: true,
      });
    });
  }

  private attach(ws: WebSocket): void {
    if (this.socket) {
      log.info('a second relay client connected; replacing the previous one');
      this.socket.close();
    }
    this.socket = ws;
    this.lastSeen = Date.now();
    log.info('relay extension connected');
    this.onStateChange?.(true);

    ws.send(JSON.stringify({ type: 'hello', token: this.token, descriptorPack: this.pack }));

    ws.on('message', (data) => {
      let msg: RelayResponse;
      try {
        msg = JSON.parse(String(data)) as RelayResponse;
      } catch {
        log.warn('relay sent a message that was not JSON');
        return;
      }
      this.lastSeen = Date.now();
      this.handle(msg);
    });

    ws.on('close', () => {
      if (this.socket === ws) {
        this.socket = null;
        this.onStateChange?.(false);
      }
      log.warn('relay extension disconnected');
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, reason: 'network', detail: 'the relay disconnected mid-action' });
        this.pending.delete(id);
      }
    });

    ws.on('error', (err) => log.warn(`relay socket error: ${err.message}`));
  }

  private handle(msg: RelayResponse): void {
    switch (msg.type) {
      case 'ready':
        this.extensionVersion = msg.extensionVersion;
        log.info(
          `relay ready: ${msg.browser}, extension ${msg.extensionVersion}, pack ${msg.descriptorPackVersion}`,
        );
        break;

      case 'delta': {
        this.pending.get(msg.id)?.onDelta?.(msg.text);
        break;
      }

      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(
          msg.ok
            ? { ok: true, text: msg.text, lossy: msg.lossy, via: msg.via }
            : { ok: false, reason: msg.reason, detail: msg.detail },
        );
        break;
      }

      case 'audit':
        // Everything the extension does inside the user's session lands in the
        // same inspectable log as everything the engine does.
        audit.record({
          actor: 'relay',
          seatId: msg.seatId,
          action: msg.action,
          target: msg.target,
          detail: msg.detail,
          ok: msg.ok,
        });
        break;

      case 'ping':
        // Application-level keepalive from the extension's connection host.
        // Answering promptly is what lets it spot a zombie socket in ~20s
        // instead of discovering it on the next action, mid-run.
        this.lastSeen = Date.now();
        this.socket?.send(JSON.stringify({ type: 'pong', at: Date.now() }));
        break;

      case 'pong':
        this.lastSeen = Date.now();
        break;

      case 'ack':
      case 'tabs':
        break;
    }
  }

  private broadcastKill(): void {
    this.socket?.send(JSON.stringify({ type: 'killswitch', engaged: true }));
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, reason: 'aborted', detail: 'the kill switch was engaged' });
      this.pending.delete(id);
    }
  }

  private validatePack(): void {
    for (const d of this.pack.descriptors) {
      const problems = validateDescriptor(d);
      if (problems.length) {
        log.warn(`descriptor "${d.provider}" has problems: ${problems.join('; ')}`);
      }
    }
  }
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
