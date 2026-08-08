/**
 * Page-side engine — the single implementation of everything that happens
 * inside a provider tab.
 *
 * It is delivered three different ways and behaves identically in all of them:
 *   1. the MV3 extension injects it as a content script;
 *   2. the CDP adapter evaluates it in an attached Chrome window;
 *   3. the dedicated-profile adapter evaluates it in an app-owned browser.
 *
 * Keeping one implementation matters because the hard parts here — composite
 * completion detection and non-lossy extraction — are where the fidelity
 * guarantees live. Three copies would drift, and the drift would be silent.
 *
 * It exposes exactly one entry point, `window.__consensusRelay.handle()`, and
 * has no dependency on the extension APIs. Streaming deltas go to an optional
 * `onDelta` callback the caller supplies.
 */

(() => {
  if (window.__consensusRelay) return;


  const CAPTURE_ON = '__consensus_capture_on';
  const CAPTURE_OFF = '__consensus_capture_off';
  const CAPTURED = '__consensus_clip';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* --------------------------------------------------------------- helpers */

  function pick(selectorList) {
    if (!selectorList || !Array.isArray(selectorList.any)) return null;
    for (const selector of selectorList.any) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch {
        /* a malformed selector in the pack must not break the whole action */
      }
    }
    return null;
  }

  function pickAll(selectorList) {
    const out = [];
    if (!selectorList || !Array.isArray(selectorList.any)) return out;
    for (const selector of selectorList.any) {
      try {
        out.push(...document.querySelectorAll(selector));
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  /** Normalise only transport artefacts — never the content itself. */
  function forCompare(s) {
    return String(s).replace(/\r\n/g, '\n').replace(/ /g, ' ').replace(/[ \t]+$/gm, '').trim();
  }

  /* ------------------------------------------------------ clipboard capture */

  /**
   * Run `fn` with the MAIN-world shim capturing clipboard writes, and resolve
   * with whatever the page tried to copy. No focus required, and the user's
   * real clipboard is never written to.
   */
  function withCapture(fn, timeoutMs = 2500) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener(CAPTURED, onCaptured);
        document.dispatchEvent(new CustomEvent(CAPTURE_OFF));
        clearTimeout(timer);
        resolve(value);
      };

      const onCaptured = (event) => finish(event.detail ?? null);

      document.addEventListener(CAPTURED, onCaptured);
      document.dispatchEvent(new CustomEvent(CAPTURE_ON));

      const timer = setTimeout(() => finish(null), timeoutMs);

      try {
        fn();
      } catch {
        finish(null);
      }
    });
  }

  /* -------------------------------------------------------------- delivery */

  async function fillComposer(el, text, mode) {
    el.focus();

    if (mode === 'textarea') {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // contenteditable: clear, then paste. Rich composers (ProseMirror, Quill)
    // handle paste correctly; a typed Enter would submit early.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete');

    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));

    await sleep(60);
    if (forCompare(readComposer(el)) !== forCompare(text)) {
      document.execCommand('insertText', false, text);
    }
  }

  function readComposer(el) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
    return el.innerText ?? el.textContent ?? '';
  }

  async function submit(descriptor, composer) {
    const button = pick(descriptor.sendButton);
    if (button && visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
      button.click();
      return;
    }
    composer.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }),
    );
  }

  /* ------------------------------------------------------------ completion */

  function failureState(descriptor) {
    const f = descriptor.failure || {};
    const map = [
      ['rateLimited', 'rate_limited'],
      ['usageCap', 'usage_cap'],
      ['loginExpired', 'login_expired'],
      ['challenge', 'challenge'],
      ['contentRefused', 'content_refused'],
    ];
    for (const [key, reason] of map) {
      const el = pick(f[key]);
      if (el && visible(el)) return { reason, detail: (el.innerText || '').slice(0, 200) };
    }
    for (const { reason, pattern } of f.textPatterns || []) {
      try {
        if (new RegExp(pattern, 'i').test(document.body.innerText.slice(0, 20_000))) {
          return { reason, detail: `matched "${pattern}"` };
        }
      } catch {
        /* ignore a bad pattern */
      }
    }
    return null;
  }

  async function awaitCompletion(descriptor, timeoutMs, onDelta) {
    const deadline = Date.now() + timeoutMs;
    const quiesceMs = Math.max(800, descriptor.completion?.quiesceMs ?? 900);
    const required = Math.max(2, descriptor.completion?.requireSignals ?? 2);

    let lastChange = Date.now();
    let lastText = '';
    let sawStopButton = false;

    const container = () => pick(descriptor.responseContainer);

    const observer = new MutationObserver(() => {
      lastChange = Date.now();
      const el = container();
      if (!el || !onDelta) return;
      const text = el.innerText || '';
      if (text.length > lastText.length) {
        onDelta(text.slice(lastText.length));
        lastText = text;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    try {
      while (Date.now() < deadline) {
        const failure = failureState(descriptor);
        if (failure) return { done: false, ...failure };

        const stopButton = pick(descriptor.completion?.stopButton);
        const stopVisible = Boolean(stopButton && visible(stopButton));
        if (stopVisible) sawStopButton = true;

        const signals = [];
        if (sawStopButton && !stopVisible) signals.push('stop-button-gone');

        const actionRow = pick(descriptor.completion?.actionRow);
        if (actionRow && visible(actionRow)) signals.push('action-row');

        const aria = pick(descriptor.completion?.ariaRegion);
        if (aria && aria.getAttribute('aria-busy') !== 'true') signals.push('aria-settled');

        const quiet = Date.now() - lastChange > quiesceMs;
        if (quiet && (container()?.innerText || '').length > 0) signals.push('quiescent');

        if (signals.length >= required) return { done: true, signals };
        await sleep(200);
      }
      return { done: false, reason: 'timeout', detail: `no completion signal within ${timeoutMs}ms` };
    } finally {
      observer.disconnect();
    }
  }

  /* ------------------------------------------------------------ extraction */

  async function extract(descriptor) {
    // Preferred: the site's own copy button, captured at the write.
    const buttons = pickAll(descriptor.copyButton).filter(visible);
    const copyButton = buttons.at(-1); // the newest message's button
    if (copyButton) {
      const captured = await withCapture(() => copyButton.click());
      if (captured?.text) {
        return { text: captured.text, lossy: false, via: 'copy_event', detail: captured.via };
      }
    }

    // Last resort: the rendered DOM. Flag it — this is the path that mangles
    // LaTeX and code blocks, and the answer is marked LOSSY all the way to the UI.
    const container = pick(descriptor.responseContainer);
    const text = container ? container.innerText || '' : '';
    return { text, lossy: true, via: 'inner_text' };
  }

  /* --------------------------------------------------------------- actions */

  /**
   * @param action     one of the fixed relay actions
   * @param descriptor the site descriptor for this provider
   * @param onDelta    optional streaming callback; the caller decides how to
   *                   ship deltas onward (extension messaging, CDP binding, …)
   */
  async function handle(action, descriptor, onDelta) {
    switch (action.kind) {
      case 'probe': {
        const failure = failureState(descriptor);
        if (failure) return { ok: false, reason: failure.reason, detail: failure.detail };
        const composer = pick(descriptor.composer);
        if (!composer) {
          return {
            ok: false,
            reason: 'not_configured',
            detail: 'composer selector did not match — the descriptor is stale for this provider',
          };
        }
        const copyPresent = pickAll(descriptor.copyButton).length > 0;
        return {
          ok: true,
          text: `composer found; copy button ${copyPresent ? 'present' : 'NOT found (extraction will be lossy)'}`,
          lossy: false,
          via: 'copy_event',
        };
      }

      case 'newThread': {
        location.assign(descriptor.newThreadUrl);
        return { ok: true, text: '', lossy: false, via: 'copy_event' };
      }

      case 'send': {
        const composer = pick(descriptor.composer);
        if (!composer) return { ok: false, reason: 'not_configured', detail: 'composer selector did not match' };

        await fillComposer(composer, action.text, descriptor.composerMode);
        await sleep(120);

        if (action.verifyEcho) {
          const echoed = readComposer(composer);
          if (forCompare(echoed) !== forCompare(action.text)) {
            // Refusing to send is the correct failure: a truncated or reflowed
            // prompt would corrupt the run silently.
            return {
              ok: false,
              reason: 'non_compliant',
              detail:
                `composer echo did not match the source (sent ${action.text.length} chars, ` +
                `composer holds ${echoed.length}); refusing to submit`,
            };
          }
        }

        await submit(descriptor, composer);
        return { ok: true, text: '', lossy: false, via: 'copy_event' };
      }

      case 'awaitAndExtract': {
        const completion = await awaitCompletion(descriptor, action.timeoutMs, (delta) => {
          try {
            onDelta?.(delta);
          } catch {
            /* a broken delta sink must never abort the extraction */
          }
        });
        if (!completion.done) {
          return { ok: false, reason: completion.reason || 'timeout', detail: completion.detail };
        }
        const extracted = await extract(descriptor);
        if (!extracted.text) {
          return { ok: false, reason: 'unknown', detail: 'completed but nothing could be extracted' };
        }
        return { ok: true, ...extracted };
      }

      case 'conformance': {
        const composer = pick(descriptor.composer);
        if (!composer) return { ok: false, reason: 'not_configured', detail: 'composer not found' };

        const prompt =
          'Repeat the text between the markers back to me exactly, byte for byte, ' +
          'with nothing added or removed and no commentary.\n\n---BEGIN---\n' +
          action.fixture +
          '\n---END---';

        await fillComposer(composer, prompt, descriptor.composerMode);
        await sleep(120);
        await submit(descriptor, composer);

        const completion = await awaitCompletion(descriptor, 120_000, null);
        if (!completion.done) {
          return { ok: false, reason: completion.reason || 'timeout', detail: completion.detail };
        }

        const extracted = await extract(descriptor);
        const captured = extracted.text.match(/---BEGIN---\n([\s\S]*?)\n---END---/);
        return {
          ok: true,
          text: captured ? captured[1] : extracted.text,
          lossy: extracted.lossy,
          via: extracted.via,
        };
      }

      case 'heal':
        // Candidates only. This function never mutates the descriptor and never
        // acts on what it finds — the engine validates a repair against a smoke
        // test before anything is cached.
        return { ok: true, text: JSON.stringify(rediscover(descriptor)), lossy: false, via: 'copy_event' };

      case 'abort':
        return { ok: true, text: '', lossy: false, via: 'copy_event' };

      default:
        // The action set is closed by design. Anything else is refused.
        return { ok: false, reason: 'not_configured', detail: `unsupported action "${action.kind}"` };
    }
  }

  /* ------------------------------------------------------- self-healing */

  /**
   * Build a selector for an element that has a chance of surviving the next
   * redeploy.
   *
   * Preference order is deliberate: test ids and ARIA labels are written by
   * humans for stability and accessibility, so they change far less often than
   * class names, which on these sites are usually generated and rotate on every
   * build. A selector built from a hashed class name is worse than no selector,
   * because it looks like it works right up until it silently does not.
   */
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return null;

    const attrs = ['data-testid', 'data-test-id', 'data-test', 'data-element-id'];
    for (const attr of attrs) {
      const v = el.getAttribute?.(attr);
      if (v) return `${el.tagName.toLowerCase()}[${attr}="${cssEscape(v)}"]`;
    }

    const aria = el.getAttribute?.('aria-label');
    if (aria) return `${el.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;

    if (el.id && !/^[0-9]/.test(el.id) && !/[:.]/.test(el.id)) return `#${el.id}`;

    const role = el.getAttribute?.('role');
    if (role) return `${el.tagName.toLowerCase()}[role="${cssEscape(role)}"]`;

    // Only keep classes that look human-written: generated ones are noise.
    const stable = [...(el.classList || [])].filter(
      (c) => c.length > 2 && c.length < 30 && /^[a-z][a-z0-9-]*$/i.test(c) && !/^[a-z]{1,3}[0-9]/i.test(c),
    );
    if (stable.length) return `${el.tagName.toLowerCase()}.${stable.slice(0, 2).map(cssEscape).join('.')}`;

    if (el.tagName === 'TEXTAREA') return 'textarea';
    if (el.getAttribute?.('contenteditable') === 'true') return 'div[contenteditable="true"]';
    return null;
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function area(el) {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  }

  function labelOf(el) {
    return `${el.getAttribute?.('aria-label') ?? ''} ${el.getAttribute?.('title') ?? ''} ${
      el.textContent ?? ''
    }`.toLowerCase();
  }

  /**
   * Heuristic re-discovery for a stale descriptor.
   *
   * Deterministic and rule-based rather than model-driven. For this specific
   * job that is a feature, not a limitation: "the composer is the biggest
   * visible editable box" and "the copy button says copy" are stable facts
   * about chat UIs, they cost nothing, and they cannot hallucinate a selector
   * that happens to parse.
   */
  function rediscover(descriptor) {
    const out = { provider: descriptor.provider, found: {}, confidence: {} };

    // Composer: the largest visible editable region.
    const editables = [
      ...document.querySelectorAll('textarea, [contenteditable="true"]'),
    ].filter((el) => visible(el) && area(el) > 400);
    editables.sort((a, b) => area(b) - area(a));
    const composer = editables[0];
    if (composer) {
      out.found.composer = selectorFor(composer);
      out.found.composerMode = composer.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable';
      out.confidence.composer = editables.length === 1 ? 'high' : 'medium';
    }

    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);

    // Send: an explicit label wins; otherwise a submit button near the composer.
    const send =
      buttons.find((b) => /\bsend\b|\bsubmit\b/.test(labelOf(b))) ??
      buttons.find((b) => b.getAttribute('type') === 'submit');
    if (send) {
      out.found.sendButton = selectorFor(send);
      out.confidence.sendButton = /\bsend\b/.test(labelOf(send)) ? 'high' : 'low';
    }

    // Stop: only present mid-generation, so absence here is not a failure.
    const stop = buttons.find((b) => /\bstop\b|\bcancel\b/.test(labelOf(b)));
    if (stop) {
      out.found.stopButton = selectorFor(stop);
      out.confidence.stopButton = 'high';
    }

    // Copy: the non-lossy extraction path, so this one matters most.
    const copies = buttons.filter((b) => /\bcopy\b/.test(labelOf(b)));
    if (copies.length) {
      out.found.copyButton = selectorFor(copies[copies.length - 1]);
      out.confidence.copyButton = 'high';
    }

    // Response container: prefer an explicit assistant-role marker, else the
    // last repeated block with substantial text.
    const roleMarked = [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible);
    if (roleMarked.length) {
      out.found.responseContainer = 'div[data-message-author-role="assistant"]:last-of-type';
      out.confidence.responseContainer = 'high';
    } else {
      const blocks = [...document.querySelectorAll('article, [role="article"], [data-message-id]')].filter(
        (el) => visible(el) && (el.innerText || '').length > 40,
      );
      const last = blocks[blocks.length - 1];
      if (last) {
        out.found.responseContainer = selectorFor(last);
        out.confidence.responseContainer = 'low';
      }
    }

    out.pageTitle = document.title;
    out.url = location.href;
    return out;
  }

  window.__consensusRelay = {
    version: '0.2.0',
    handle,
    rediscover,
    // Exposed for the conformance suite and for descriptor debugging.
    probeSelectors: (descriptor) => ({
      composer: Boolean(pick(descriptor.composer)),
      sendButton: Boolean(pick(descriptor.sendButton)),
      responseContainer: Boolean(pick(descriptor.responseContainer)),
      copyButton: pickAll(descriptor.copyButton).length,
      stopButton: Boolean(pick(descriptor.completion?.stopButton)),
    }),
  };
})();
