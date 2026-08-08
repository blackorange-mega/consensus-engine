import type { DescriptorPack } from '@consensus/shared';

/**
 * The shipped descriptor pack.
 *
 * HONESTY NOTE, and it matters more than the selectors themselves:
 * every selector below is a starting guess. Provider UIs change weekly, these
 * were not validated against a live logged-in session at build time, and
 * `copyYieldsMarkdown` is marked `assumed` for every provider because section
 * 5.3B is explicit that it is an assumption about someone else's UI rather than
 * a guarantee.
 *
 * That is why the architecture does not depend on them being right:
 *   - the conformance test runs on launch for every enabled seat
 *     and turns red when a descriptor is stale, before a run is wasted;
 *   - the LaTeX round-trip check proves or disproves `copyYieldsMarkdown` per
 *     provider, and a provider that fails it is marked LOSSY in the UI;
 *   - self-healing re-discovers selectors and caches the repair;
 *   - the pack is hot-updatable, so a fix never waits for an app release.
 *
 * Treat a red conformance chip as the normal state after a provider redesign,
 * not as a bug in the engine.
 */
export const DEFAULT_DESCRIPTOR_PACK: DescriptorPack = {
  version: '2026.08.08-1',
  updatedAt: '2026-08-08T00:00:00Z',
  source: 'bundled',
  descriptors: [
    {
      provider: 'chatgpt',
      displayName: 'ChatGPT',
      origins: ['https://chatgpt.com', 'https://chat.openai.com'],
      newThreadUrl: 'https://chatgpt.com/',
      composerMode: 'contenteditable',
      pacingMs: [600, 2200],
      composer: {
        any: ['#prompt-textarea', 'div[contenteditable="true"][id="prompt-textarea"]', 'form textarea'],
        note: 'ProseMirror contenteditable; paste rather than value-set',
      },
      sendButton: {
        any: ['button[data-testid="send-button"]', 'button[aria-label*="Send"]'],
      },
      responseContainer: {
        any: [
          'article[data-testid^="conversation-turn"]:last-of-type div[data-message-author-role="assistant"]',
          'div[data-message-author-role="assistant"]:last-of-type',
        ],
      },
      copyButton: {
        any: ['button[data-testid="copy-turn-action-button"]', 'button[aria-label="Copy"]'],
        note: 'the non-lossy extraction path; proven or disproven by the conformance test',
      },
      completion: {
        stopButton: { any: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]'] },
        actionRow: { any: ['div[data-testid="conversation-turn-actions"]', 'button[aria-label="Read aloud"]'] },
        ariaRegion: { any: ['div[aria-live="polite"]'] },
        quiesceMs: 900,
        requireSignals: 2,
      },
      failure: {
        rateLimited: { any: ['div[role="alert"]'] },
        usageCap: { any: ['div[data-testid="usage-limit"]'] },
        loginExpired: { any: ['button[data-testid="login-button"]', 'a[href*="/auth/login"]'] },
        challenge: { any: ['iframe[title*="challenge"]', 'div#challenge-running'] },
        textPatterns: [
          { reason: 'usage_cap', pattern: "You've reached your .* limit" },
          { reason: 'rate_limited', pattern: 'Too many requests|slow down' },
          { reason: 'content_refused', pattern: "I can't help with that|against our usage policies" },
        ],
      },
      assumptions: { copyYieldsMarkdown: 'assumed' },
    },

    {
      provider: 'claude',
      displayName: 'Claude',
      origins: ['https://claude.ai'],
      newThreadUrl: 'https://claude.ai/new',
      composerMode: 'contenteditable',
      pacingMs: [600, 2200],
      composer: {
        any: ['div[contenteditable="true"].ProseMirror', 'div[enterkeyhint="enter"][contenteditable="true"]'],
      },
      sendButton: { any: ['button[aria-label="Send message"]', 'button[aria-label*="Send"]'] },
      responseContainer: {
        any: ['div[data-test-render-count] :last-child .font-claude-message', 'div.font-claude-message:last-of-type'],
      },
      copyButton: { any: ['button[data-testid="action-bar-copy"]', 'button[aria-label="Copy"]'] },
      completion: {
        stopButton: { any: ['button[aria-label="Stop response"]', 'button[aria-label*="Stop"]'] },
        actionRow: { any: ['div[data-testid="action-bar"]'] },
        quiesceMs: 900,
        requireSignals: 2,
      },
      failure: {
        rateLimited: { any: ['div[role="alert"]'] },
        usageCap: { any: ['div[data-testid="usage-limit-banner"]'] },
        loginExpired: { any: ['a[href*="/login"]'] },
        textPatterns: [
          { reason: 'usage_cap', pattern: 'message limit|out of free messages|limit resets' },
          { reason: 'rate_limited', pattern: 'sending messages too quickly' },
        ],
      },
      assumptions: { copyYieldsMarkdown: 'assumed' },
    },

    {
      provider: 'gemini',
      displayName: 'Gemini',
      origins: ['https://gemini.google.com'],
      newThreadUrl: 'https://gemini.google.com/app',
      composerMode: 'contenteditable',
      pacingMs: [800, 2500],
      composer: { any: ['div.ql-editor[contenteditable="true"]', 'rich-textarea div[contenteditable="true"]'] },
      sendButton: { any: ['button[aria-label*="Send"]', 'button.send-button'] },
      responseContainer: { any: ['model-response:last-of-type message-content', 'div.model-response-text'] },
      copyButton: { any: ['button[data-test-id="copy-button"]', 'button[aria-label="Copy"]'] },
      completion: {
        stopButton: { any: ['button[aria-label*="Stop"]', 'button.stop-button'] },
        actionRow: { any: ['message-actions', 'div.response-footer'] },
        quiesceMs: 1100,
        requireSignals: 2,
      },
      failure: {
        loginExpired: { any: ['a[href*="accounts.google.com"]'] },
        textPatterns: [{ reason: 'rate_limited', pattern: 'try again later|too many requests' }],
      },
      assumptions: { copyYieldsMarkdown: 'assumed' },
    },

    {
      provider: 'grok',
      displayName: 'Grok',
      origins: ['https://grok.com', 'https://x.com'],
      newThreadUrl: 'https://grok.com/',
      composerMode: 'textarea',
      pacingMs: [700, 2400],
      composer: { any: ['textarea[aria-label*="Ask"]', 'form textarea'] },
      sendButton: { any: ['button[type="submit"]', 'button[aria-label*="Submit"]'] },
      responseContainer: { any: ['div.message-bubble:last-of-type', 'div[data-testid="response"]:last-of-type'] },
      copyButton: { any: ['button[aria-label="Copy"]', 'button[data-testid="copy"]'] },
      completion: {
        stopButton: { any: ['button[aria-label*="Stop"]'] },
        actionRow: { any: ['div.message-actions'] },
        quiesceMs: 1000,
        requireSignals: 2,
      },
      failure: {
        loginExpired: { any: ['a[href*="/login"]'] },
        textPatterns: [{ reason: 'rate_limited', pattern: 'rate limit|try again' }],
      },
      assumptions: { copyYieldsMarkdown: 'assumed' },
    },

    {
      provider: 'deepseek',
      displayName: 'DeepSeek',
      origins: ['https://chat.deepseek.com'],
      newThreadUrl: 'https://chat.deepseek.com/',
      composerMode: 'textarea',
      pacingMs: [700, 2400],
      composer: { any: ['textarea#chat-input', 'form textarea'] },
      sendButton: { any: ['div[role="button"][aria-disabled="false"]', 'button[type="submit"]'] },
      responseContainer: { any: ['div.ds-markdown:last-of-type'] },
      copyButton: { any: ['div[role="button"][aria-label="Copy"]', 'button[aria-label="Copy"]'] },
      completion: {
        stopButton: { any: ['div[role="button"][aria-label*="Stop"]'] },
        actionRow: { any: ['div.ds-message-actions'] },
        quiesceMs: 1000,
        requireSignals: 2,
      },
      failure: {
        textPatterns: [{ reason: 'rate_limited', pattern: 'server is busy|try again' }],
      },
      assumptions: { copyYieldsMarkdown: 'assumed' },
    },
  ],
};
