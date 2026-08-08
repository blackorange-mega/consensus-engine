/**
 * Connection host.
 *
 * Owns the WebSocket to the local engine and nothing else. It forwards every
 * inbound action to the service worker (which owns tabs and scripting) and
 * sends the reply back out.
 *
 * Why this file exists at all: an MV3 service worker is killed after ~30s idle,
 * taking the socket and every attached tab with it. That is a well-known
 * failure in exactly this architecture — OpenClaw hit it too. Chrome 116+
 * keeps the worker alive while WebSocket messages are flowing, but a run spends
 * most of its time waiting for a model to generate, so traffic-based keepalive
 * alone is not enough. An offscreen document is exempt from that lifecycle.
 *
 * Belt and braces: we also send an application-level ping every 20s, so a dead
 * connection is detected quickly rather than at the next action.
 */

const DEFAULT_ENGINE = 'ws://127.0.0.1:8787/relay';
const EXTENSION_VERSION = '0.2.0';
const PING_INTERVAL_MS = 20_000;
const PONG_GRACE_MS = 15_000;

let socket = null;
let reconnectDelay = 500;
let reconnectTimer = null;
let pingTimer = null;
let lastPongAt = 0;
let descriptorPackVersion = 'none';
let lastError = null;

function log(...args) {
  console.log('[relay:offscreen]', ...args);
}

async function config() {
  const stored = await chrome.storage.local.get(['engineUrl', 'token']);
  return { engineUrl: stored.engineUrl || DEFAULT_ENGINE, token: stored.token || '' };
}

function post(message) {
  // Fire-and-forget to the service worker. It may be asleep; Chrome wakes it.
  chrome.runtime.sendMessage({ __relay: true, ...message }).catch(() => {});
}

function sendToEngine(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function stopTimers() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, reconnectDelay);
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  let engineUrl;
  let token;
  try {
    ({ engineUrl, token } = await config());
  } catch (err) {
    // Storage can throw if this document outlived an extension reload. Say so
    // loudly rather than dying quietly, and keep retrying.
    lastError = `could not read settings: ${String(err)}`;
    log(lastError);
    post({ type: 'status', connected: false, reason: 'storage-error', detail: lastError });
    scheduleReconnect();
    return;
  }

  if (!token) {
    // Not an error — the user simply has not paired yet. Keep waiting: the
    // storage listener below fires the moment they do, and the retry timer is
    // the backstop. Returning without either was the original bug.
    lastError = 'waiting for a pairing token';
    log(lastError);
    post({ type: 'status', connected: false, reason: 'no-token' });
    scheduleReconnect();
    return;
  }

  try {
    socket = new WebSocket(`${engineUrl}?token=${encodeURIComponent(token)}`);
  } catch (err) {
    log('could not open socket', err);
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    reconnectDelay = 500;
    lastPongAt = Date.now();
    lastError = null;
    log('connected');

    sendToEngine({
      type: 'ready',
      extensionVersion: EXTENSION_VERSION,
      browser: navigator.userAgent,
      descriptorPackVersion,
    });
    post({ type: 'status', connected: true });

    stopTimers();
    pingTimer = setInterval(() => {
      // An unanswered ping means the socket is a zombie: close it and let the
      // reconnect path take over rather than silently dropping actions.
      if (lastPongAt && Date.now() - lastPongAt > PING_INTERVAL_MS + PONG_GRACE_MS) {
        log('engine stopped answering pings; reconnecting');
        try {
          socket.close();
        } catch {
          /* already closing */
        }
        return;
      }
      sendToEngine({ type: 'ping', at: Date.now() });
    }, PING_INTERVAL_MS);
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'pong' || msg.type === 'ping') {
      lastPongAt = Date.now();
      if (msg.type === 'ping') sendToEngine({ type: 'pong', at: Date.now() });
      return;
    }

    if (msg.type === 'hello') {
      descriptorPackVersion = msg.descriptorPack?.version ?? descriptorPackVersion;
      post({ type: 'pack', descriptorPack: msg.descriptorPack });
      return;
    }

    if (msg.type === 'killswitch') {
      post({ type: 'killswitch', engaged: Boolean(msg.engaged) });
      return;
    }

    if (msg.type === 'action') {
      post({ type: 'action', id: msg.id, seatId: msg.seatId, action: msg.action });
    }
  };

  socket.onclose = () => {
    log('disconnected');
    stopTimers();
    post({ type: 'status', connected: false, reason: 'closed' });
    scheduleReconnect();
  };

  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* already closing */
    }
  };
}

// Replies and telemetry coming back from the service worker.
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || msg.__toEngine !== true) return false;

  if (msg.kind === 'send') {
    const ok = sendToEngine(msg.payload);
    respond({ ok });
    return true;
  }

  if (msg.kind === 'status') {
    respond({
      connected: socket?.readyState === WebSocket.OPEN,
      packVersion: descriptorPackVersion,
      lastError,
    });
    return true;
  }

  if (msg.kind === 'reconnect') {
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    socket = null;
    reconnectDelay = 300;
    void connect();
    respond({ ok: true });
    return true;
  }

  return false;
});

/**
 * React the moment the user pairs.
 *
 * The original bug lived here as an absence: `connect()` ran once when this
 * document was created, found no token, and returned with nothing scheduled to
 * try again. Pasting the token afterwards only helped if one fragile message
 * hop happened to land — and when it did not, the extension sat silently
 * forever with a valid token in storage and no socket.
 *
 * Watching storage makes pairing take effect immediately and removes the
 * dependency on that hop entirely.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes.token && !changes.engineUrl) return;

  log('settings changed; reconnecting');
  try {
    socket?.close();
  } catch {
    /* ignore */
  }
  socket = null;
  reconnectDelay = 300;
  void connect();
});

/**
 * Backstop. If we are not connected for any reason at all, keep trying.
 *
 * Cheap, and it covers every failure mode rather than only the ones we thought
 * of — including the engine simply not being started yet, which is the most
 * common one in practice.
 */
setInterval(() => {
  if (!socket || socket.readyState === WebSocket.CLOSED) void connect();
}, 15_000);

void connect();
