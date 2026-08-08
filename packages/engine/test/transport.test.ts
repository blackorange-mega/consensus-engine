import { describe, expect, it } from 'vitest';

import type { Capabilities, ConsensusReport, RunRecord, TransportFamily } from '@consensus/shared';
import { DEFAULT_RUN_SETTINGS } from '@consensus/shared';

import { backoffFor, classify, describe as describeError, parseRetryAfter, refineFromBody } from '../src/adapters/errors.js';
import { FailoverAdapter } from '../src/adapters/failover.js';
import { AdapterError, type ModelAdapter, type SendResult } from '../src/adapters/types.js';
import { calibrateConfidence, scoreSelfConsistency, vendorOf } from '../src/verification/index.js';

/* ------------------------------------------------------------ error policy */

describe('error classification', () => {
  it('separates a rate limit from an exhausted quota', () => {
    const rateLimited = classify(new AdapterError('rate_limited', '429', 'Too many requests, slow down'));
    expect(rateLimited.retryable).toBe(true);
    expect(rateLimited.terminal).toBe(false);

    // The distinction that matters: same status code, opposite handling.
    const outOfCredit = classify(
      new AdapterError('rate_limited', '429', 'You exceeded your current quota, please check your billing'),
    );
    expect(outOfCredit.reason).toBe('usage_cap');
    expect(outOfCredit.retryable).toBe(false);
    expect(outOfCredit.terminal).toBe(true);
  });

  it('treats an Anthropic overload as transient, not as a cap', () => {
    expect(refineFromBody('unknown', '{"type":"error","error":{"type":"overloaded_error"}}')).toBe('rate_limited');
  });

  it('reads Google RESOURCE_EXHAUSTED both ways', () => {
    expect(refineFromBody('unknown', 'RESOURCE_EXHAUSTED: quota exceeded for billing account')).toBe('usage_cap');
    expect(refineFromBody('unknown', 'RESOURCE_EXHAUSTED: too many concurrent requests')).toBe('rate_limited');
  });

  it('recognises an expired key as a login problem', () => {
    expect(refineFromBody('unknown', '{"error":{"code":"invalid_api_key"}}')).toBe('login_expired');
  });

  it('never fails over on a content refusal — another transport refuses too', () => {
    const policy = classify(new AdapterError('content_refused', 'declined'));
    expect(policy.failover).toBe(false);
  });

  it('never fails over on an abort', () => {
    expect(classify(new AdapterError('aborted', 'stopped')).failover).toBe(false);
  });

  it('always offers the user a next step', () => {
    for (const reason of ['rate_limited', 'usage_cap', 'login_expired', 'challenge', 'network'] as const) {
      expect(classify(new AdapterError(reason, 'x')).remediation.length).toBeGreaterThan(20);
    }
  });
});

describe('Retry-After', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
  });

  it('reads an HTTP date', () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(30_000);
    expect(ms).toBeLessThanOrEqual(45_000);
  });

  it('clamps absurd values rather than stalling a run for an hour', () => {
    expect(parseRetryAfter('999999')).toBe(10 * 60_000);
  });

  it('ignores nonsense', () => {
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it('prefers the provider\'s wait over our own backoff', () => {
    const policy = classify(new AdapterError('rate_limited', '429'), { headers: { 'retry-after': '7' } });
    expect(backoffFor(policy, 1)).toBe(7_000);
  });

  it('jitters its own backoff so seats do not retry in lockstep', () => {
    const policy = classify(new AdapterError('network', 'boom'));
    const samples = new Set(Array.from({ length: 20 }, () => backoffFor(policy, 3)));
    expect(samples.size).toBeGreaterThan(1);
  });

  it('describes a failure in one actionable line', () => {
    const text = describeError(classify(new AdapterError('usage_cap', 'cap')), 'detail here');
    expect(text).toContain('usage_cap');
    expect(text).toContain('seat dropped');
  });
});

/* --------------------------------------------------------------- failover */

const CAPS: Capabilities = {
  streaming: true,
  rawCopy: true,
  newThread: true,
  concurrent: true,
  systemPrompt: true,
  temperature: true,
  attachments: false,
  quotaVisible: false,
};

function stub(kind: string, behaviour: () => Promise<SendResult>): ModelAdapter {
  return {
    id: `stub-${kind}`,
    displayName: kind,
    kind: kind as ModelAdapter['kind'],
    family: 'api' as TransportFamily,
    capabilities: { ...CAPS },
    send: behaviour,
    health: async () => ({ ok: true }),
  };
}

describe('failover chain', () => {
  it('uses the primary while it works', async () => {
    const seat = new FailoverAdapter('s', 'S', [
      stub('relay', async () => ({ text: 'from relay' })),
      stub('openai', async () => ({ text: 'from api' })),
    ]);
    expect((await seat.send('q', { timeoutMs: 1000 })).text).toBe('from relay');
  });

  it('degrades to the next transport when the primary dies terminally', async () => {
    const seat = new FailoverAdapter('s', 'S', [
      stub('relay', async () => {
        throw new AdapterError('login_expired', 'session gone');
      }),
      stub('openai', async () => ({ text: 'from api' })),
    ]);

    const result = await seat.send('q', { timeoutMs: 1000 });
    expect(result.text).toBe('from api');
    expect(seat.current.kind).toBe('openai');
  });

  it('stays on the fallback once it has switched', async () => {
    let relayCalls = 0;
    const seat = new FailoverAdapter('s', 'S', [
      stub('relay', async () => {
        relayCalls++;
        throw new AdapterError('challenge', 'captcha');
      }),
      stub('openai', async () => ({ text: 'ok' })),
    ]);

    await seat.send('q', { timeoutMs: 1000 });
    await seat.send('q', { timeoutMs: 1000 });
    expect(relayCalls).toBe(1); // the dead transport is not retried every call
  });

  it('does not fail over on a content refusal', async () => {
    let apiCalled = false;
    const seat = new FailoverAdapter('s', 'S', [
      stub('relay', async () => {
        throw new AdapterError('content_refused', 'declined');
      }),
      stub('openai', async () => {
        apiCalled = true;
        return { text: 'should not happen' };
      }),
    ]);

    await expect(seat.send('q', { timeoutMs: 1000 })).rejects.toThrow();
    expect(apiCalled).toBe(false);
  });

  it('reports the intersection of capabilities, not the primary\'s', () => {
    const noStream = stub('openai', async () => ({ text: '' }));
    noStream.capabilities.streaming = false;
    const seat = new FailoverAdapter('s', 'S', [stub('relay', async () => ({ text: '' })), noStream]);
    expect(seat.capabilities.streaming).toBe(false);
  });

  it('throws when every transport is gone', async () => {
    const seat = new FailoverAdapter('s', 'S', [
      stub('relay', async () => {
        throw new AdapterError('network', 'down');
      }),
      stub('openai', async () => {
        throw new AdapterError('network', 'also down');
      }),
    ]);
    await expect(seat.send('q', { timeoutMs: 1000 })).rejects.toThrow();
  });
});

/* ----------------------------------------------------------- verification */

describe('self-consistency scoring', () => {
  it('recognises a seat that reproduces its own answer', () => {
    const r = scoreSelfConsistency({
      seatId: 'a',
      declaredKey: '42',
      resampledKeys: ['42', '42'],
      tolerance: 1e-9,
    });
    expect(r.selfConsistent).toBe(true);
    expect(r.agreementRate).toBe(1);
  });

  it('catches a seat that cannot reproduce its own answer', () => {
    const r = scoreSelfConsistency({
      seatId: 'a',
      declaredKey: '42',
      resampledKeys: ['43', '44'],
      tolerance: 1e-9,
    });
    expect(r.selfConsistent).toBe(false);
    expect(r.agreementRate).toBeCloseTo(1 / 3);
  });

  it('does not count formatting differences as inconsistency', () => {
    const r = scoreSelfConsistency({
      seatId: 'a',
      declaredKey: '5',
      resampledKeys: ['5.0', 'The answer is 5'],
      tolerance: 1e-9,
    });
    expect(r.selfConsistent).toBe(true);
  });
});

describe('confidence calibration', () => {
  const baseRun = (over: Partial<RunRecord> = {}): RunRecord =>
    ({
      id: 'r',
      createdAt: 0,
      updatedAt: 0,
      prompt: 'q',
      title: 'q',
      status: 'done',
      outcome: 'converged',
      settings: DEFAULT_RUN_SETTINGS,
      classification: null,
      seatIds: ['claude-cli', 'openai-api', 'gemini-api'],
      primarySeatId: 'claude-cli',
      rounds: [],
      seats: {
        'claude-cli': seatState('claude-cli'),
        'openai-api': seatState('openai-api'),
        'gemini-api': seatState('gemini-api'),
      },
      finalAnswer: 'x',
      finalAnswerKey: 'x',
      templateSnapshot: {},
      verification: null,
      stats: { calls: 3, failedCalls: 0, rounds: 1, wallMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, messagesPerSeat: {} },
      ...over,
    }) as RunRecord;

  const seatState = (id: string) =>
    ({
      seatId: id,
      displayName: id,
      adapter: 'cli',
      family: 'cli' as TransportFamily,
      status: 'healthy',
      answer: 'x',
      answerKey: 'x',
      flips: 0,
      agreedRounds: [1],
      messagesUsed: 1,
    }) as RunRecord['seats'][string];

  const consensus = (seatIds: string[]): ConsensusReport => ({
    equivalent: true,
    judge: 'structured',
    camps: [{ key: 'x', label: 'x', seatIds, representativeAnswer: 'x' }],
  });

  const families = { 'claude-cli': 'cli', 'openai-api': 'api', 'gemini-api': 'api' } as Record<string, TransportFamily>;
  const vendors = { 'claude-cli': 'claude', 'openai-api': 'openai', 'gemini-api': 'gemini' };

  it('rates unanimous round-1 agreement across three vendors highly', () => {
    const report = calibrateConfidence({
      run: baseRun(),
      consensus: consensus(['claude-cli', 'openai-api', 'gemini-api']),
      reliability: [],
      familyOf: families,
      vendorOf: vendors,
    });
    expect(report.band).toBe('high');
    expect(report.factors.some((f) => f.name === 'independent agreement')).toBe(true);
  });

  it('penalises a homogeneous panel — agreement between clones is one vote', () => {
    const sameVendor = { 'claude-cli': 'claude', 'openai-api': 'claude', 'gemini-api': 'claude' };
    const diverse = calibrateConfidence({
      run: baseRun(),
      consensus: consensus(['claude-cli', 'openai-api', 'gemini-api']),
      reliability: [],
      familyOf: families,
      vendorOf: vendors,
    });
    const clones = calibrateConfidence({
      run: baseRun(),
      consensus: consensus(['claude-cli', 'openai-api', 'gemini-api']),
      reliability: [],
      familyOf: families,
      vendorOf: sameVendor,
    });
    expect(clones.confidence).toBeLessThan(diverse.confidence);
    expect(clones.factors.find((f) => f.name === 'panel heterogeneity')?.detail).toContain('same vendor');
  });

  it('penalises agreement that was reached by capitulation', () => {
    const run = baseRun();
    run.seats['gemini-api']!.flips = 3;
    const report = calibrateConfidence({
      run,
      consensus: consensus(['claude-cli', 'openai-api', 'gemini-api']),
      reliability: [],
      familyOf: families,
      vendorOf: vendors,
    });
    expect(report.factors.some((f) => f.name === 'position changes' && f.contribution < 0)).toBe(true);
  });

  it('rewards a dissenter accepting the answer more than a supporter doing so', () => {
    const withDissenter = calibrateConfidence({
      run: baseRun(),
      consensus: consensus(['claude-cli', 'openai-api']),
      reliability: [],
      crossCheck: { verifierSeatId: 'gemini-api', wasDissenter: true, agrees: true },
      familyOf: families,
      vendorOf: vendors,
    });
    const withSupporter = calibrateConfidence({
      run: baseRun(),
      consensus: consensus(['claude-cli', 'openai-api']),
      reliability: [],
      crossCheck: { verifierSeatId: 'gemini-api', wasDissenter: false, agrees: true },
      familyOf: families,
      vendorOf: vendors,
    });
    expect(withDissenter.confidence).toBeGreaterThan(withSupporter.confidence);
  });

  it('drops hard when the cross-check rejects the answer', () => {
    const report = calibrateConfidence({
      run: baseRun(),
      consensus: consensus(['claude-cli', 'openai-api']),
      reliability: [],
      crossCheck: { verifierSeatId: 'gemini-api', wasDissenter: true, agrees: false, objection: 'off by one' },
      familyOf: families,
      vendorOf: vendors,
    });
    expect(report.confidence).toBeLessThan(0.6);
    expect(report.factors.some((f) => f.contribution < -0.2)).toBe(true);
  });

  it('refuses to be confident about a run that did not converge', () => {
    const report = calibrateConfidence({
      run: baseRun({ outcome: 'unresolved', finalAnswerKey: null }),
      consensus: null,
      reliability: [],
      familyOf: families,
      vendorOf: vendors,
    });
    expect(report.band).toBe('low');
    expect(report.summary).toContain('did not agree');
  });

  it('always itemises its reasoning', () => {
    const report = calibrateConfidence({
      run: baseRun(),
      consensus: consensus(['claude-cli', 'openai-api', 'gemini-api']),
      reliability: [],
      familyOf: families,
      vendorOf: vendors,
    });
    expect(report.factors.length).toBeGreaterThan(1);
    for (const f of report.factors) expect(f.detail.length).toBeGreaterThan(10);
    // Never presented as a claim about truth.
    expect(report.summary).toContain('not whether the answer is true');
  });
});

describe('vendor inference for the heterogeneity term', () => {
  it('collapses aliases so one vendor is not counted twice', () => {
    expect(vendorOf('anthropic-api', 'anthropic')).toBe('claude');
    expect(vendorOf('chatgpt-web', 'relay')).toBe('openai');
    expect(vendorOf('google-api', 'google')).toBe('gemini');
  });

  it('treats an unrecognised seat as its own vendor rather than guessing', () => {
    expect(vendorOf('my-local-thing', 'ollama')).toContain('my-local-thing');
  });
});
