import { createHash, randomBytes } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function shortHash(input: string, len = 12): string {
  return sha256(input).slice(0, len);
}

/**
 * Per-round nonce used in the peer-content delimiters. A model
 * answer cannot forge a closing delimiter it has never seen, so quoted peer
 * text cannot break out of its data region.
 */
export function nonce(bytes = 6): string {
  return randomBytes(bytes).toString('hex');
}

export function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** Stable hash of a set of answers, for oscillation detection. */
export function answerSetHash(keys: string[]): string {
  return shortHash([...keys].sort().join('\u0000'), 16);
}
