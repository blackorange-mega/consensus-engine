import { describe, expect, it } from 'vitest';

import type { SiteDescriptor } from '@consensus/shared';

import { DEFAULT_DESCRIPTOR_PACK } from '../src/relay/defaultPack.js';
import { applyRepair, buildRepair, isWorthTrying, parseCandidates } from '../src/relay/selfHeal.js';

const base = (): SiteDescriptor => structuredClone(DEFAULT_DESCRIPTOR_PACK.descriptors[0]!);

describe('descriptor self-healing', () => {
  it('prepends a new selector without discarding the old one', () => {
    const current = base();
    const before = current.composer.any.length;

    const repair = buildRepair(current, {
      provider: current.provider,
      found: { composer: '#new-composer' },
      confidence: { composer: 'high' },
    });

    expect(repair.candidate.composer.any[0]).toBe('#new-composer');
    // The previous selector survives as a fallback, so a wrong guess is not
    // destructive and an A/B-tested layout keeps working.
    expect(repair.candidate.composer.any.length).toBe(before + 1);
    expect(repair.changed).toContain('composer');
  });

  it('does not mutate the descriptor it was given', () => {
    const current = base();
    const snapshot = JSON.stringify(current);
    buildRepair(current, { provider: current.provider, found: { composer: '#x' }, confidence: {} });
    expect(JSON.stringify(current)).toBe(snapshot);
  });

  it('marks a repaired copy button as unproven again', () => {
    const current = base();
    current.assumptions.copyYieldsMarkdown = 'verified';

    const repair = buildRepair(current, {
      provider: current.provider,
      found: { copyButton: 'button.new-copy' },
      confidence: {},
    });

    // A new copy button has not been through the LaTeX round trip yet, so the
    // fidelity claim resets rather than being inherited.
    expect(repair.candidate.assumptions.copyYieldsMarkdown).toBe('assumed');
  });

  it('reports selectors the page could not find', () => {
    const repair = buildRepair(base(), {
      provider: 'chatgpt',
      found: { composer: '#c' },
      confidence: {},
    });
    expect(repair.stillMissing).toContain('sendButton');
    expect(repair.stillMissing).toContain('copyButton');
  });

  it('refuses a proposal that changes nothing', () => {
    const current = base();
    const repair = buildRepair(current, {
      provider: current.provider,
      found: { composer: current.composer.any[0] },
      confidence: {},
    });
    const verdict = isWorthTrying(repair);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('no changes');
  });

  it('refuses a proposal with no composer — there is nothing to repair against', () => {
    const repair = buildRepair(base(), { provider: 'chatgpt', found: {}, confidence: {} });
    expect(isWorthTrying(repair).ok).toBe(false);
  });

  it('refuses a repair that would produce an invalid descriptor', () => {
    const current = base();
    current.completion.requireSignals = 1; // below the composite-signal floor
    const repair = buildRepair(current, {
      provider: current.provider,
      found: { composer: '#c', sendButton: '#s' },
      confidence: {},
    });
    expect(isWorthTrying(repair).ok).toBe(false);
    expect(isWorthTrying(repair).reason).toContain('invalid');
  });

  it('accepts a real repair', () => {
    const repair = buildRepair(base(), {
      provider: 'chatgpt',
      found: { composer: '#c', sendButton: '#s', copyButton: '#cp' },
      confidence: {},
    });
    expect(isWorthTrying(repair).ok).toBe(true);
  });

  it('bumps the pack version so a healed pack is distinguishable', () => {
    const pack = structuredClone(DEFAULT_DESCRIPTOR_PACK);
    const repaired = buildRepair(base(), {
      provider: 'chatgpt',
      found: { composer: '#c' },
      confidence: {},
    }).candidate;

    const next = applyRepair(pack, repaired);
    expect(next.version).not.toBe(pack.version);
    expect(next.descriptors).toHaveLength(pack.descriptors.length);
    expect(next.descriptors.find((d) => d.provider === 'chatgpt')?.composer.any[0]).toBe('#c');
    // Other providers are untouched.
    expect(next.descriptors.find((d) => d.provider === 'claude')).toEqual(
      pack.descriptors.find((d) => d.provider === 'claude'),
    );
  });

  it('rejects an unreadable proposal rather than guessing', () => {
    expect(parseCandidates('not json')).toBeNull();
    expect(parseCandidates('{"nope":1}')).toBeNull();
    expect(parseCandidates('{"provider":"x","found":{},"confidence":{}}')).not.toBeNull();
  });
});
