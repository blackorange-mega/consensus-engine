/**
 * Site descriptors for the browser relay.
 *
 * These are *declarative data*, not code, and they live in a versioned pack
 * that can be hot-updated without shipping a new build -- provider selectors
 * break weekly and "wait for a release" is not an acceptable repair path.
 *
 * The relay is a transport, not an agent: nothing here lets a model choose
 * what to click. The action set is fixed (see `RelayAction`) and a descriptor
 * only ever names *where* the fixed actions apply.
 */

export interface SelectorList {
  /** Tried in order; first match wins. Multiple entries survive A/B tests. */
  any: string[];
  /** Human note for the self-healing pass and for the activity log. */
  note?: string;
}

export interface CompletionSignals {
  /**
   * The strongest and most portable signal: the stop/abort button reverting
   * to the send button.
   */
  stopButton: SelectorList;
  /** Post-completion action row (copy / regenerate / thumbs) appearing. */
  actionRow: SelectorList;
  /** aria-live / aria-busy region that settles when generation ends. */
  ariaRegion?: SelectorList;
  /** MutationObserver quiescence window, tuned per provider. Minimum 800ms. */
  quiesceMs: number;
  /** How many of the available signals must agree before we call it done. */
  requireSignals: number;
}

export interface FailureSignals {
  rateLimited?: SelectorList;
  usageCap?: SelectorList;
  loginExpired?: SelectorList;
  challenge?: SelectorList;
  contentRefused?: SelectorList;
  /** Text patterns checked against the visible error region. */
  textPatterns?: Array<{ reason: string; pattern: string }>;
}

export interface SiteDescriptor {
  /** Stable provider id, e.g. "chatgpt". */
  provider: string;
  displayName: string;
  /** Exact origins the relay is permitted to touch for this provider. */
  origins: string[];
  /** Where to open a fresh conversation. */
  newThreadUrl: string;
  composer: SelectorList;
  sendButton: SelectorList;
  /** The last assistant message container. */
  responseContainer: SelectorList;
  /** The provider's own copy button -- the non-lossy extraction path. */
  copyButton: SelectorList;
  /** Optional: a network route the page itself calls, for a lossless read. */
  jsonEndpointPattern?: string;
  completion: CompletionSignals;
  failure: FailureSignals;
  /**
   * Newlines must be entered as Shift+Enter; plain Enter submits. Some
   * composers are contenteditable and need a paste event instead of value-set.
   */
  composerMode: 'contenteditable' | 'textarea';
  /** Randomised pre-send delay window, so we do not burst-fire the account. */
  pacingMs: [number, number];
  /** Verified assumptions. `copyYieldsMarkdown` MUST be proven per provider. */
  assumptions: {
    copyYieldsMarkdown: 'verified' | 'assumed' | 'refuted';
    verifiedAt?: string;
  };
}

export interface DescriptorPack {
  version: string;
  updatedAt: string;
  /** Where an updated pack can be fetched from; user-configurable. */
  source?: string;
  descriptors: SiteDescriptor[];
}

/** A descriptor is only usable if every selector group it needs is non-empty. */
export function validateDescriptor(d: SiteDescriptor): string[] {
  const problems: string[] = [];
  const need: Array<[string, SelectorList | undefined]> = [
    ['composer', d.composer],
    ['sendButton', d.sendButton],
    ['responseContainer', d.responseContainer],
    ['copyButton', d.copyButton],
    ['completion.stopButton', d.completion?.stopButton],
  ];
  for (const [name, sel] of need) {
    if (!sel || !Array.isArray(sel.any) || sel.any.length === 0) {
      problems.push(`missing selector: ${name}`);
    }
  }
  if (!d.origins?.length) problems.push('descriptor declares no origins');
  if (d.completion && d.completion.quiesceMs < 800) {
    problems.push('completion.quiesceMs below the 800ms floor');
  }
  if (d.completion && d.completion.requireSignals < 2) {
    problems.push('completion.requireSignals must be at least 2 (composite signal)');
  }
  return problems;
}

/** Origin allow-listing: the relay must never be a "run JS anywhere" capability. */
export function originAllowed(pack: DescriptorPack, url: string): boolean {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return pack.descriptors.some((d) => d.origins.includes(origin));
}
