import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { WebSocketServer } from 'ws';

import type { RunControl } from '@consensus/shared';

import { CONFIG, ENGINE_VERSION, REPO_ROOT } from '../config.js';
import type { Engine } from '../engine.js';
import { templates } from '../prompts/loader.js';
import { audit } from '../runtime/audit.js';
import { killSwitch } from '../runtime/killSwitch.js';
import { logger } from '../util/logger.js';

const log = logger('http');

const UI_DIST = resolve(REPO_ROOT, 'packages', 'ui', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // Prompts can legitimately be large; 32 MB is a sanity ceiling, not a limit
    // the user should ever meet.
    if (size > 32 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Local-first HTTP + WebSocket surface.
 *
 * Bound to loopback by default. The mobile path is "engine on the desktop,
 * responsive web client over the LAN", so the host is configurable —
 * but binding beyond loopback is an explicit, logged choice, never the default.
 */
export function startServer(engine: Engine): Server {
  const server = createServer((req, res) => {
    handle(engine, req, res).catch((err) => {
      log.error(`unhandled request error: ${String(err)}`);
      if (!res.headersSent) send(res, 500, { error: String(err) });
    });
  });

  // UI event stream.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws') return; // /relay is handled by RelayServer
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'hello', engineVersion: ENGINE_VERSION, killSwitch: killSwitch.isEngaged }));
      const unsubscribe = engine.subscribe((event) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(event));
      });
      ws.on('close', unsubscribe);
      ws.on('error', unsubscribe);
    });
  });

  engine.attachRelay(server);

  server.listen(CONFIG.port, CONFIG.host, () => {
    log.info(`engine listening on http://${CONFIG.host}:${CONFIG.port}`);
    if (CONFIG.host !== '127.0.0.1' && CONFIG.host !== 'localhost') {
      log.warn(
        `the engine is bound to ${CONFIG.host}, which is reachable beyond this machine — ` +
          'anyone who can reach it can start runs inside your logged-in sessions',
      );
    }
  });

  return server;
}

async function handle(engine: Engine, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // The UI is same-origin; no cross-origin caller has any business here.
  res.setHeader('x-content-type-options', 'nosniff');

  if (!path.startsWith('/api/')) return serveStatic(path, res);

  /* --------------------------------------------------------------- health */

  if (path === '/api/health' && method === 'GET') {
    return send(res, 200, {
      ok: true,
      version: engine.version(),
      killSwitch: killSwitch.isEngaged,
      relay: engine.relayStatus(),
    });
  }

  /* ---------------------------------------------------------------- seats */

  if (path === '/api/seats' && method === 'GET') {
    return send(res, 200, { seats: engine.getSeats(), health: await engine.refreshHealth() });
  }
  if (path === '/api/seats' && method === 'PUT') {
    const body = await readBody<{ seats: Parameters<Engine['setSeats']>[0] }>(req);
    return send(res, 200, { seats: engine.setSeats(body.seats) });
  }
  if (path === '/api/seats/discover' && method === 'POST') {
    return send(res, 200, await engine.discover());
  }

  const conformanceMatch = path.match(/^\/api\/seats\/([^/]+)\/conformance$/);
  if (conformanceMatch && method === 'POST') {
    try {
      return send(res, 200, await engine.runConformance(decodeURIComponent(conformanceMatch[1]!)));
    } catch (err) {
      return send(res, 400, { error: String(err) });
    }
  }

  // Approving a desktop app for automation is a deliberate, explicit act by the
  // user — the seat refuses to send anything until this has been called.
  const confirmMatch = path.match(/^\/api\/seats\/([^/]+)\/confirm$/);
  if (confirmMatch && method === 'POST') {
    const seatId = decodeURIComponent(confirmMatch[1]!);
    const ok = engine.confirmDesktopSeat(seatId);
    return ok
      ? send(res, 200, { ok: true, seatId })
      : send(res, 400, { error: `seat "${seatId}" is not a desktop seat` });
  }

  /* ------------------------------------------------------------- settings */

  if (path === '/api/settings' && method === 'GET') return send(res, 200, engine.getSettings());
  if (path === '/api/settings' && method === 'PUT') {
    return send(res, 200, engine.setSettings(await readBody(req)));
  }

  /* ------------------------------------------------------------------ runs */

  if (path === '/api/preflight' && method === 'POST') {
    const body = await readBody<{ settings?: Parameters<Engine['estimate']>[0] }>(req);
    return send(res, 200, engine.estimate(body.settings ?? {}));
  }

  if (path === '/api/runs' && method === 'GET') return send(res, 200, { runs: engine.listRuns() });

  if (path === '/api/runs' && method === 'POST') {
    const body = await readBody<{ prompt?: string; settings?: Parameters<Engine['startRun']>[1] }>(req);
    if (!body.prompt || !body.prompt.trim()) return send(res, 400, { error: 'prompt is required' });
    return send(res, 201, engine.startRun(body.prompt, body.settings ?? {}));
  }

  const runMatch = path.match(/^\/api\/runs\/([^/]+)(?:\/(.+))?$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]!);
    const sub = runMatch[2];

    if (!sub && method === 'GET') {
      const run = engine.getRun(runId);
      return run ? send(res, 200, run) : send(res, 404, { error: 'no such run' });
    }

    if (sub === 'control' && method === 'POST') {
      try {
        engine.control(runId, await readBody<RunControl>(req));
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, 409, { error: String(err) });
      }
    }

    if (sub === 'report' && method === 'GET') {
      const report = engine.report(runId);
      return report ? send(res, 200, report) : send(res, 404, { error: 'no such run' });
    }

    if (sub === 'report.md' && method === 'GET') {
      const md = engine.reportMarkdown(runId);
      if (!md) return send(res, 404, { error: 'no such run' });
      return send(res, 200, md, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${runId}.md"`,
      });
    }

    if (sub === 'export' && method === 'GET') {
      const bundle = engine.exportRun(runId);
      if (!bundle) return send(res, 404, { error: 'no such run' });
      return send(res, 200, bundle, {
        'content-disposition': `attachment; filename="${runId}.json"`,
      });
    }

    if (sub === 'turns' && method === 'GET') {
      return send(res, 200, { turns: engine.store.getTurns(runId) });
    }
  }

  if (path === '/api/runs/import' && method === 'POST') {
    const body = await readBody<Parameters<Engine['importRun']>[0]>(req);
    return send(res, 201, { runId: engine.importRun(body) });
  }

  /* ------------------------------------------------------------ scoreboard */

  if (path === '/api/scoreboard' && method === 'GET') return send(res, 200, { entries: engine.scoreboard() });

  /* ------------------------------------------------------------- templates */

  if (path === '/api/templates' && method === 'GET') return send(res, 200, { templates: templates.list() });

  const tplMatch = path.match(/^\/api\/templates\/([^/]+)$/);
  if (tplMatch && method === 'PUT') {
    const body = await readBody<{ body: string }>(req);
    try {
      return send(res, 200, templates.save(decodeURIComponent(tplMatch[1]!), body.body));
    } catch (err) {
      return send(res, 400, { error: String(err) });
    }
  }

  /* ------------------------------------------------------- automation, audit */

  if (path === '/api/audit' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 200);
    return send(res, 200, {
      entries: audit.recent(limit, url.searchParams.get('runId') ?? undefined),
      chain: audit.verify(),
    });
  }

  if (path === '/api/killswitch' && method === 'POST') {
    const body = await readBody<{ engaged: boolean }>(req);
    if (body.engaged) killSwitch.engage('user');
    else killSwitch.release('user');
    return send(res, 200, { engaged: killSwitch.isEngaged });
  }

  if (path === '/api/automation' && method === 'POST') {
    const body = await readBody<{ disabled: boolean }>(req);
    engine.setAutomationDisabled(body.disabled);
    return send(res, 200, { disabled: body.disabled });
  }

  /* ------------------------------------------------------------ descriptors */

  if (path === '/api/descriptors' && method === 'GET') {
    return send(res, 200, { pack: engine.getPack(), relay: engine.relayStatus() });
  }
  // Re-discover selectors for a provider whose descriptor has gone stale.
  // The engine validates any repair before caching it.
  const healMatch = path.match(/^\/api\/descriptors\/([^/]+)\/heal$/);
  if (healMatch && method === 'POST') {
    return send(res, 200, await engine.healDescriptor(decodeURIComponent(healMatch[1]!)));
  }

  if (path === '/api/descriptors' && method === 'PUT') {
    const body = await readBody<{ pack: Parameters<Engine['setPack']>[0] }>(req);
    return send(res, 200, { pack: engine.setPack(body.pack) });
  }

  if (path === '/api/relay/token' && method === 'GET') {
    // Loopback-only by construction; the token pairs the extension to this engine.
    return send(res, 200, { token: engine.relayPairingToken(), url: `ws://${CONFIG.host}:${CONFIG.port}/relay` });
  }

  send(res, 404, { error: `no route for ${method} ${path}` });
}

/** Serve the built UI, with traversal protection. */
function serveStatic(path: string, res: ServerResponse): void {
  if (!existsSync(UI_DIST)) {
    return send(
      res,
      200,
      'Consensus Engine is running.\n\n' +
        'The UI has not been built yet. Run:\n\n' +
        '  npm run build --workspace @consensus/ui\n\n' +
        'or use the dev server:\n\n' +
        '  npm run dev:ui\n',
    );
  }

  const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  const target = join(UI_DIST, normalize(relative));
  if (!target.startsWith(UI_DIST)) return send(res, 403, { error: 'forbidden' });

  const file = existsSync(target) && statSync(target).isFile() ? target : join(UI_DIST, 'index.html');
  if (!existsSync(file)) return send(res, 404, { error: 'not found' });

  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}
