import type { Stubbornness } from '@consensus/shared';

import { templates } from '../prompts/loader.js';
import { nonce as makeNonce } from '../util/hash.js';
import { assertVerbatim } from '../util/mustache.js';
import { buildPeerBlock, critiqueSkeleton, sanitizePeerText, type PeerBlockInput } from './sanitize.js';

/**
 * Prompt construction for every phase.
 *
 * Two invariants are asserted here rather than hoped for:
 *   1. The full original user prompt appears verbatim in every phase-2 and
 *      phase-3 prompt. It is never paraphrased.
 *   2. Peer answers are sanitised and delimited before embedding.
 *
 * Invariant 1 is checked with a byte-exact substring assertion, so a template
 * edit that accidentally reflows the question fails loudly instead of quietly
 * changing what the panel is debating.
 */

export interface BuiltPrompt {
  prompt: string;
  nonce: string;
  /** Letters this seat was asked about, in order. */
  peerLetters: string[];
  /** What the sanitiser neutralised in each peer's text, for the report. */
  stripped: Record<string, string[]>;
  /** Peers whose text looked like a prompt-injection attempt. */
  suspiciousLetters: string[];
}

export function buildDispatchPrompt(userPrompt: string, requireKey: boolean): BuiltPrompt {
  const n = makeNonce();
  const prompt = templates.render('dispatch', {
    prompt: userPrompt,
    require_key: requireKey,
    nonce: n,
  });
  assertVerbatim(prompt, userPrompt, 'the user prompt');
  return { prompt, nonce: n, peerLetters: [], stripped: {}, suspiciousLetters: [] };
}

export interface CrossExamInput {
  userPrompt: string;
  selfLetter: string;
  selfAnswer: string;
  peers: PeerBlockInput[];
  /** Total seats still in the panel, for the "N independent experts" framing. */
  panelSize: number;
}

/** Phase 2/3, call 1: equivalence judgement only — judge and defendant stay separate. */
export function buildJudgePrompt(input: CrossExamInput): BuiltPrompt {
  const n = makeNonce();
  const block = buildPeerBlock(input.peers, n);
  const letters = input.peers.map((p) => p.letter);

  const prompt = templates.render('cross_judge', {
    original_prompt: input.userPrompt,
    self_letter: input.selfLetter,
    self_answer: input.selfAnswer,
    peers: block.text,
    panel_size: input.panelSize,
    peer_count: input.peers.length,
    critique_skeleton: critiqueSkeleton(letters),
    nonce: n,
  });

  assertVerbatim(prompt, input.userPrompt, 'the user prompt');
  return {
    prompt,
    nonce: n,
    peerLetters: letters,
    stripped: block.stripped,
    suspiciousLetters: block.suspiciousLetters,
  };
}

export interface ReviseInput extends CrossExamInput {
  stubbornness: Stubbornness;
  /** True from round 3 on, when conceded critics have been pruned away. */
  isFollowup: boolean;
}

/** Phase 2/3, call 2: re-examine and give a final answer for the round. */
export function buildRevisePrompt(input: ReviseInput): BuiltPrompt {
  const n = makeNonce();
  const block = buildPeerBlock(input.peers, n);
  const letters = input.peers.map((p) => p.letter);

  const prompt = templates.render('cross_revise', {
    original_prompt: input.userPrompt,
    self_letter: input.selfLetter,
    self_answer: input.selfAnswer,
    peers: block.text,
    panel_size: input.panelSize,
    is_followup: input.isFollowup,
    stubbornness_clause: templates.stubbornnessClause(input.stubbornness),
    critique_skeleton: critiqueSkeleton(letters),
    nonce: n,
  });

  assertVerbatim(prompt, input.userPrompt, 'the user prompt');
  return {
    prompt,
    nonce: n,
    peerLetters: letters,
    stripped: block.stripped,
    suspiciousLetters: block.suspiciousLetters,
  };
}

/** Optional final step: restate the agreed answer in full. */
export function buildRewritePrompt(userPrompt: string, agreedAnswer: string): BuiltPrompt {
  const n = makeNonce();
  const prompt = templates.render('final_rewrite', {
    original_prompt: userPrompt,
    agreed_answer: agreedAnswer,
    nonce: n,
  });
  assertVerbatim(prompt, userPrompt, 'the user prompt');
  return { prompt, nonce: n, peerLetters: [], stripped: {}, suspiciousLetters: [] };
}

export function buildClassifyPrompt(userPrompt: string): BuiltPrompt {
  const n = makeNonce();
  const prompt = templates.render('classify', { prompt: userPrompt, nonce: n });
  assertVerbatim(prompt, userPrompt, 'the user prompt');
  return { prompt, nonce: n, peerLetters: [], stripped: {}, suspiciousLetters: [] };
}

export function buildRepairPrompt(letters: string[], needAnswer: boolean): string {
  const critiques = letters.length
    ? `,\n "critiques": {${letters.map((l) => `"${l}": null`).join(', ')}}`
    : '';
  const answer = needAnswer ? `,\n "answer": "<your final answer>"` : '';
  return templates.render('repair', {
    expected_shape: `{"agree": true|false${answer},\n "answer_key": "<the bare claim>"${critiques}}`,
  });
}

/**
 * Verification layer: a seat reviews the agreed answer cold.
 *
 * The answer under review came out of a model, so it is untrusted input to the
 * reviewer exactly like a peer answer is — it gets the same sanitisation, and
 * the template wraps it in its own delimited region.
 */
export function buildCrossCheckPrompt(userPrompt: string, agreedAnswer: string): BuiltPrompt {
  const n = makeNonce();
  const cleaned = sanitizePeerText(agreedAnswer, n);

  const prompt = templates.render('cross_check', {
    original_prompt: userPrompt,
    agreed_answer: cleaned.text,
    nonce: n,
  });

  assertVerbatim(prompt, userPrompt, 'the user prompt');
  return {
    prompt,
    nonce: n,
    peerLetters: [],
    stripped: cleaned.stripped.length ? { X: cleaned.stripped } : {},
    suspiciousLetters: cleaned.suspicious ? ['X'] : [],
  };
}
