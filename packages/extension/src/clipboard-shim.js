/**
 * Clipboard capture shim — runs in the page's MAIN world.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The non-lossy way to extract a model's answer is to click the provider's own
 * "Copy" button, which puts the original source markdown (LaTeX, code fences and
 * all) on the clipboard rather than the rendered DOM text.
 *
 * But `navigator.clipboard.readText()` throws `DOMException: Document is not
 * focused` in any tab that is not the focused one. This relay deliberately keeps
 * provider tabs warm in the background and never steals focus, so reading the
 * clipboard back would fail for essentially every real run. Focusing each tab in
 * turn would fix it and ruin the product: a run is a multi-minute background job
 * and it must not fight the user for their screen.
 *
 * THE FIX
 *
 * Do not read the clipboard. Intercept the write.
 *
 * Sites copy in one of three ways, and all three are patched here:
 *   1. `navigator.clipboard.writeText(text)`   — modern React apps
 *   2. `navigator.clipboard.write([ClipboardItem])`
 *   3. `document.execCommand('copy')` over a selection — older flows
 *
 * While the relay is capturing, the patched call records the exact string and
 * **suppresses the real write**, so the user's actual clipboard is never
 * touched. Outside capture mode every call passes straight through unchanged.
 *
 * This also removes the need for the `clipboardRead`/`clipboardWrite`
 * permissions entirely, and removes the save/restore dance and the cross-tab
 * clipboard lock that a real clipboard read would have required.
 */

(() => {
  if (window.__consensusClipShim) return;
  window.__consensusClipShim = true;

  const CAPTURE_ON = '__consensus_capture_on';
  const CAPTURE_OFF = '__consensus_capture_off';
  const CAPTURED = '__consensus_clip';

  let capturing = false;

  const announce = (text, via) => {
    try {
      document.dispatchEvent(new CustomEvent(CAPTURED, { detail: { text, via } }));
    } catch {
      /* never let instrumentation break the page */
    }
  };

  document.addEventListener(CAPTURE_ON, () => {
    capturing = true;
  });
  document.addEventListener(CAPTURE_OFF, () => {
    capturing = false;
  });

  /* ------------------------------------------- navigator.clipboard.writeText */

  const clipboard = navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    const originalWriteText = clipboard.writeText.bind(clipboard);
    Object.defineProperty(clipboard, 'writeText', {
      configurable: true,
      writable: true,
      value: function writeText(text) {
        if (capturing) {
          announce(String(text), 'writeText');
          // Suppress the real write: the user's clipboard stays untouched, and
          // the site sees a normal resolved promise so its UI still shows
          // "Copied!" and nothing downstream breaks.
          return Promise.resolve();
        }
        return originalWriteText(text);
      },
    });
  }

  /* ----------------------------------------------- navigator.clipboard.write */

  if (clipboard && typeof clipboard.write === 'function') {
    const originalWrite = clipboard.write.bind(clipboard);
    Object.defineProperty(clipboard, 'write', {
      configurable: true,
      writable: true,
      value: function write(items) {
        if (!capturing) return originalWrite(items);
        try {
          const item = Array.isArray(items) ? items[0] : undefined;
          if (item && typeof item.getType === 'function') {
            const type = (item.types || []).includes('text/plain') ? 'text/plain' : (item.types || [])[0];
            if (type) {
              return item
                .getType(type)
                .then((blob) => blob.text())
                .then((text) => {
                  announce(text, 'write');
                });
            }
          }
        } catch {
          /* fall through to the passthrough below */
        }
        return Promise.resolve();
      },
    });
  }

  /* ------------------------------------------------- document.execCommand */

  const originalExec = document.execCommand?.bind(document);
  if (originalExec) {
    document.execCommand = function execCommand(command, ...rest) {
      if (capturing && String(command).toLowerCase() === 'copy') {
        // Older flows select text in a hidden field and copy the selection.
        let text = '';
        try {
          const active = document.activeElement;
          if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
            const el = active;
            text = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? el.value.length) || el.value;
          }
          if (!text) text = String(window.getSelection() ?? '');
        } catch {
          /* ignore */
        }
        if (text) {
          announce(text, 'execCommand');
          return true; // report success without touching the real clipboard
        }
      }
      return originalExec(command, ...rest);
    };
  }

  /* --------------------------------------------------- the copy event path */

  // Some sites write via a `copy` event handler that calls setData directly.
  // Reading in the bubble phase means the page's own handler has already run.
  document.addEventListener(
    'copy',
    (event) => {
      if (!capturing) return;
      try {
        const text = event.clipboardData?.getData('text/plain');
        if (text) {
          announce(text, 'copyEvent');
          // Cancel the write so the real clipboard is left alone.
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      } catch {
        /* ignore */
      }
    },
    false,
  );
})();
