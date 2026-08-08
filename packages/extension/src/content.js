/**
 * Extension bridge.
 *
 * All the page logic lives in `page-core.js`, which is shared with the CDP and
 * dedicated-profile transports. This file does one job: connect Chrome's
 * messaging to that shared entry point, and ship streaming deltas back to the
 * service worker.
 *
 * Keeping it this thin is the point — the completion-detection and extraction
 * code is the part that must not exist in three slightly different copies.
 */

(() => {
  if (window.__consensusBridgeLoaded) return;
  window.__consensusBridgeLoaded = true;

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    // Liveness probe used by the service worker before it trusts this tab.
    if (msg?.type === 'relay:ping') {
      respond({ ok: true, core: Boolean(window.__consensusRelay) });
      return true;
    }

    if (msg?.type !== 'relay') return false;

    const core = window.__consensusRelay;
    if (!core) {
      respond({
        ok: false,
        reason: 'not_configured',
        detail: 'page-core.js is not present in this tab',
      });
      return true;
    }

    const onDelta = (text) => {
      chrome.runtime.sendMessage({ type: 'relay:delta', requestId: msg.requestId, text }).catch(() => {});
    };

    core
      .handle(msg.action, msg.descriptor, onDelta)
      .then(respond)
      .catch((err) => respond({ ok: false, reason: 'unknown', detail: String(err) }));

    return true; // keep the channel open for the async reply
  });
})();
