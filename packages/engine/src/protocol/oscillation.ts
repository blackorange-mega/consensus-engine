import { answerSetHash } from '../util/hash.js';

/**
 * Termination guarantee.
 *
 * A panel can cycle: A and B swap positions every round and never settle.
 * Hashing the multiset of normalised answers each round catches that — if a
 * hash repeats, the panel is revisiting a state it has already been in, and
 * more rounds will not help.
 */

export interface OscillationState {
  hashes: string[];
}

export function newOscillationState(): OscillationState {
  return { hashes: [] };
}

export interface OscillationCheck {
  hash: string;
  oscillating: boolean;
  /** The earlier round with the same state (1-indexed), when repeating. */
  repeatOfRound?: number;
  /** 2 = immediate repeat, 3 = A/B/A/B cycle, etc. */
  cycleLength?: number;
}

/**
 * Record this round's state and report whether the panel is cycling.
 * `keys` are normalised answer keys, one per surviving seat.
 */
export function recordRound(state: OscillationState, keys: string[]): OscillationCheck {
  const hash = answerSetHash(keys);
  const previous = state.hashes.indexOf(hash);
  state.hashes.push(hash);

  if (previous === -1) return { hash, oscillating: false };

  return {
    hash,
    oscillating: true,
    repeatOfRound: previous + 1,
    cycleLength: state.hashes.length - 1 - previous,
  };
}
