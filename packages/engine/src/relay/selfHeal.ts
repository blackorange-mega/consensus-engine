import type { DescriptorPack, SiteDescriptor } from '@consensus/shared';
import { validateDescriptor } from '@consensus/shared';

import { audit } from '../runtime/audit.js';
import { logger } from '../util/logger.js';

const log = logger('self-heal');

/**
 * Descriptor self-healing.
 *
 * Provider UIs change without warning and a stale selector takes a seat offline
 * silently. The repair path must not be "wait for an app release".
 *
 * The flow is deliberately conservative:
 *   1. the page proposes candidate selectors (heuristics only — see
 *      `page-core.js`, which never acts on what it finds);
 *   2. the engine merges them into a *copy* of the descriptor, keeping the
 *      existing selectors as fallbacks rather than replacing them;
 *   3. the caller validates the candidate against a real smoke test;
 *   4. only a candidate that passes is written to the pack.
 *
 * A repair is never applied on the strength of the proposal alone. A selector
 * that matches the wrong element is worse than one that matches nothing: the
 * first sends a prompt into the void and reports success, the second fails
 * loudly and turns the health chip red.
 */

export interface HealCandidates {
  provider: string;
  found: Partial<{
    composer: string;
    composerMode: 'textarea' | 'contenteditable';
    sendButton: string;
    stopButton: string;
    copyButton: string;
    responseContainer: string;
  }>;
  confidence: Partial<Record<string, 'high' | 'medium' | 'low'>>;
  pageTitle?: string;
  url?: string;
}

export interface HealResult {
  provider: string;
  /** Candidate descriptor, ready to be validated. Never auto-applied. */
  candidate: SiteDescriptor;
  /** Which selector groups the page proposed a change for. */
  changed: string[];
  /** Groups the page could not find at all. */
  stillMissing: string[];
  problems: string[];
}

export function parseCandidates(raw: string): HealCandidates | null {
  try {
    const parsed = JSON.parse(raw) as HealCandidates;
    return parsed && typeof parsed === 'object' && parsed.found ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Merge candidates into a descriptor.
 *
 * New selectors are *prepended*, not substituted. If the page was wrong the old
 * selector is still there as a fallback, and if a provider A/B-tests two layouts
 * both end up covered — which is the common case in practice.
 */
export function buildRepair(current: SiteDescriptor, candidates: HealCandidates): HealResult {
  const candidate: SiteDescriptor = structuredClone(current);
  const changed: string[] = [];
  const stillMissing: string[] = [];

  const prepend = (list: { any: string[] }, selector: string | undefined, name: string) => {
    if (!selector) {
      stillMissing.push(name);
      return;
    }
    if (list.any[0] === selector) return; // already the preferred selector
    list.any = [selector, ...list.any.filter((s) => s !== selector)].slice(0, 6);
    changed.push(name);
  };

  prepend(candidate.composer, candidates.found.composer, 'composer');
  prepend(candidate.sendButton, candidates.found.sendButton, 'sendButton');
  prepend(candidate.responseContainer, candidates.found.responseContainer, 'responseContainer');
  prepend(candidate.copyButton, candidates.found.copyButton, 'copyButton');
  prepend(candidate.completion.stopButton, candidates.found.stopButton, 'completion.stopButton');

  if (candidates.found.composerMode && candidates.found.composerMode !== candidate.composerMode) {
    candidate.composerMode = candidates.found.composerMode;
    changed.push('composerMode');
  }

  // A repaired copy button is unproven until the LaTeX round trip says so.
  if (changed.includes('copyButton')) {
    candidate.assumptions = { ...candidate.assumptions, copyYieldsMarkdown: 'assumed' };
  }

  return {
    provider: current.provider,
    candidate,
    changed,
    stillMissing,
    problems: validateDescriptor(candidate),
  };
}

/** Write a validated repair into the pack and bump its version. */
export function applyRepair(pack: DescriptorPack, repaired: SiteDescriptor): DescriptorPack {
  const descriptors = pack.descriptors.map((d) => (d.provider === repaired.provider ? repaired : d));
  const next: DescriptorPack = {
    ...pack,
    descriptors,
    version: bumpVersion(pack.version),
    updatedAt: new Date().toISOString(),
  };

  log.info(`descriptor "${repaired.provider}" repaired; pack is now ${next.version}`);
  audit.record({
    actor: 'engine',
    action: 'descriptor.repaired',
    target: repaired.provider,
    detail: `pack ${pack.version} -> ${next.version}`,
    ok: true,
  });
  return next;
}

/** `2026.08.08-1` -> `2026.08.08-2`, so a healed pack is distinguishable. */
function bumpVersion(version: string): string {
  const m = version.match(/^(.*)-(\d+)$/);
  if (m) return `${m[1]}-${Number(m[2]) + 1}`;
  return `${version}-healed-1`;
}

/**
 * Is this repair worth attempting at all?
 *
 * A proposal that changes nothing, or that could not find the composer, is not
 * a repair — reporting it as one would send the user chasing a fix that never
 * happened.
 */
export function isWorthTrying(result: HealResult): { ok: boolean; reason: string } {
  if (result.problems.length) {
    return { ok: false, reason: `the repaired descriptor is invalid: ${result.problems.join('; ')}` };
  }
  if (result.changed.length === 0) {
    return {
      ok: false,
      reason:
        'the page proposed no changes — the descriptor is probably fine and the failure is elsewhere ' +
        '(not logged in, rate limited, or a network problem)',
    };
  }
  if (result.stillMissing.includes('composer')) {
    return {
      ok: false,
      reason: 'no composer could be found on the page, so there is nothing to repair against',
    };
  }
  return { ok: true, reason: `proposes changes to ${result.changed.join(', ')}` };
}
