/**
 * Service worker: owns tabs, scripting and the descriptor pack.
 *
 * It deliberately does NOT own the WebSocket — that lives in the offscreen
 * document, because this worker gets terminated after ~30s idle and would take
 * the connection and every attached tab with it.
 *
 * Security posture (unchanged and non-negotiable):
 *   - the action set is a closed union; there is no "run arbitrary JS" verb;
 *   - a tab is only touched if its origin is declared by a descriptor;
 *   - every action is reported to the engine for the activity log;
 *   - the kill switch halts everything immediately.
 */

const EXTENSION_VERSION = '0.2.0';
const KEEPALIVE_ALARM = 'relay-keepalive';
const INJECT_RETRY_MS = 400;
const INJECT_ATTEMPTS = 3;

let descriptorPack = { version: 'none', descriptors: [] };
let killed = false;
let connected = false;
/** provider -> tabId, kept warm across rounds. */
const warmTabs = new Map();

/* ------------------------------------------------------------- offscreen */

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['WORKERS'],
      justification:
        'Maintains the persistent WebSocket connection to the local Consensus Engine, which must survive ' +
        'service worker termination during long model generations.',
    });
  } catch (err) {
    // A concurrent call may have created it already; anything else is real.
    if (!String(err).includes('Only a single offscreen')) console.error('[relay] offscreen failed', err);
  }
}

function toEngine(payload) {
  return chrome.runtime.sendMessage({ __toEngine: true, kind: 'send', payload }).catch(() => ({ ok: false }));
}

function audit(seatId, action, target, detail, ok) {
  void toEngine({ type: 'audit', seatId, action, target, detail, ok });
}

function setBadge(text, colour) {
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color: colour });
}

/* ------------------------------------------------------------------ tabs */

function descriptorFor(provider) {
  return descriptorPack.descriptors.find((d) => d.provider === provider);
}

/** Origin allow-listing: the relay must never become a general automation capability. */
function originAllowed(descriptor, url) {
  try {
    return descriptor.origins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

async function tabIsReady(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'relay:ping' });
    return res?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Make sure the content script is actually live in this tab.
 *
 * Declaring a content script in the manifest is not enough: Chrome does not
 * re-inject into already-open tabs after an install, update or reload, so
 * `tabs.sendMessage` fails with "Receiving end does not exist" on exactly the
 * tabs a user is most likely to already have open. Injecting on demand fixes
 * that, and is idempotent because the content script guards against double-load.
 */
async function ensureContentScript(tabId) {
  if (await tabIsReady(tabId)) return true;

  for (let attempt = 1; attempt <= INJECT_ATTEMPTS; attempt++) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/clipboard-shim.js'],
        world: 'MAIN',
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/page-core.js', 'src/content.js'],
      });
    } catch (err) {
      // Page may still be navigating; retry rather than failing the action.
      if (attempt === INJECT_ATTEMPTS) {
        console.warn('[relay] injection failed', err);
        return false;
      }
    }
    await new Promise((r) => setTimeout(r, INJECT_RETRY_MS));
    if (await tabIsReady(tabId)) return true;
  }
  return false;
}

async function findOrOpenTab(descriptor) {
  const warm = warmTabs.get(descriptor.provider);
  if (warm !== undefined) {
    try {
      const tab = await chrome.tabs.get(warm);
      if (tab && originAllowed(descriptor, tab.url || '')) return tab;
    } catch {
      warmTabs.delete(descriptor.provider);
    }
  }

  const patterns = descriptor.origins.map((o) => `${o}/*`);
  const found = await chrome.tabs.query({ url: patterns });
  if (found.length > 0) {
    warmTabs.set(descriptor.provider, found[0].id);
    return found[0];
  }

  // Opened inactive so a run never steals the user's focus mid-work.
  const created = await chrome.tabs.create({ url: descriptor.newThreadUrl, active: false });
  warmTabs.set(descriptor.provider, created.id);
  await waitForTabLoad(created.id, 25_000);
  return await chrome.tabs.get(created.id);
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((t) => {
      if (t?.status === 'complete') done();
    });
  });
}

/* --------------------------------------------------------------- actions */

async function runAction(seatId, action, requestId) {
  if (killed) return { ok: false, reason: 'aborted', detail: 'the kill switch is engaged' };

  if (action.kind === 'abort') return { ok: true, text: '', lossy: false, via: 'copy_event' };

  const descriptor = descriptorFor(action.provider);
  if (!descriptor) {
    return { ok: false, reason: 'not_configured', detail: `no descriptor for "${action.provider}"` };
  }

  let tab;
  try {
    tab = await findOrOpenTab(descriptor);
  } catch (err) {
    return { ok: false, reason: 'network', detail: String(err) };
  }

  if (!tab || !originAllowed(descriptor, tab.url || '')) {
    audit(seatId, 'relay.origin_refused', tab?.url, 'tab is not on a registered origin', false);
    return { ok: false, reason: 'not_configured', detail: 'the tab is not on a registered origin' };
  }

  if (!(await ensureContentScript(tab.id))) {
    return {
      ok: false,
      reason: 'network',
      detail: 'the page script could not be injected — the tab may still be loading or blocked',
    };
  }

  if (action.kind === 'ensureTab') {
    audit(seatId, 'relay.ensureTab', descriptor.provider, `tab ${tab.id}`, true);
    return { ok: true, text: String(tab.id), lossy: false, via: 'copy_event' };
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'relay',
      requestId,
      action,
      descriptor,
    });

    audit(
      seatId,
      `relay.${action.kind}`,
      descriptor.provider,
      response?.ok ? response.detail || response.via || 'ok' : response?.detail || 'failed',
      Boolean(response?.ok),
    );

    // A navigation (newThread) tears the content script down mid-reply.
    if (!response) return { ok: true, text: '', lossy: false, via: 'copy_event' };
    return response;
  } catch (err) {
    return { ok: false, reason: 'network', detail: String(err) };
  }
}

/* -------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  // From the offscreen connection host.
  if (msg?.__relay === true) {
    if (msg.type === 'status') {
      connected = Boolean(msg.connected);
      setBadge(connected ? (killed ? 'off' : 'on') : '', connected ? (killed ? '#dc2626' : '#16a34a') : '#6b7280');
      return false;
    }
    if (msg.type === 'pack') {
      descriptorPack = msg.descriptorPack || descriptorPack;
      return false;
    }
    if (msg.type === 'killswitch') {
      killed = Boolean(msg.engaged);
      setBadge(killed ? 'off' : 'on', killed ? '#dc2626' : '#16a34a');
      return false;
    }
    if (msg.type === 'action') {
      void runAction(msg.seatId, msg.action, msg.id).then((result) =>
        toEngine({ type: 'result', id: msg.id, ...result }),
      );
      return false;
    }
    return false;
  }

  // Streaming deltas coming up from a content script.
  if (msg?.type === 'relay:delta') {
    void toEngine({ type: 'delta', id: msg.requestId, text: msg.text });
    return false;
  }

  // From the popup.
  if (msg?.type === 'relay:status') {
    void (async () => {
      await ensureOffscreen();
      const status = await chrome.runtime
        .sendMessage({ __toEngine: true, kind: 'status' })
        .catch(() => null);
      respond({
        connected: status?.connected ?? connected,
        packVersion: status?.packVersion ?? descriptorPack.version,
        providers: descriptorPack.descriptors.map((d) => d.provider),
        killed,
        extensionVersion: EXTENSION_VERSION,
      });
    })();
    return true;
  }

  if (msg?.type === 'relay:reconnect') {
    void (async () => {
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ __toEngine: true, kind: 'reconnect' }).catch(() => {});
      respond({ ok: true });
    })();
    return true;
  }

  return false;
});

/* ------------------------------------------------------------- lifecycle */

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [provider, id] of warmTabs) if (id === tabId) warmTabs.delete(provider);
});

// A recurring alarm wakes the worker periodically. The offscreen document keeps
// the socket alive on its own; this just makes sure the worker is around to
// service actions promptly rather than cold-starting on every one.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) void ensureOffscreen();
});

chrome.runtime.onInstalled.addListener(() => void ensureOffscreen());
chrome.runtime.onStartup.addListener(() => void ensureOffscreen());
void ensureOffscreen();
