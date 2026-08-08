/**
 * Expert-letter assignment.
 *
 * Models are addressed as "Expert A/B/C/D" and never by brand name -- a model
 * that knows it is grading Claude or Gemini plays favourites. The
 * anonymisation trick is borrowed from karpathy/llm-council.
 *
 * The mapping is reshuffled every round so no seat is permanently "Expert A",
 * which kills position bias. Shuffling is seeded and therefore reproducible:
 * a run can be replayed exactly.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Deterministic 32-bit PRNG (mulberry32). Reproducible replays matter more than entropy here. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Assign a letter to each seat for one round.
 * Seat order is sorted first so the input ordering of `seatIds` cannot leak
 * position information into the assignment.
 */
export function assignLetters(seatIds: string[], runId: string, round: number): Record<string, string> {
  const sorted = [...seatIds].sort();
  const rng = seededRandom(hashSeed(`${runId}:${round}`));
  const pool = sorted.map((_, i) => ALPHABET[i % ALPHABET.length] as string);

  // Fisher-Yates over the letter pool.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = pool[i] as string;
    const b = pool[j] as string;
    pool[i] = b;
    pool[j] = a;
  }

  const out: Record<string, string> = {};
  sorted.forEach((id, i) => {
    out[id] = pool[i] as string;
  });
  return out;
}

/** Invert a letter map: "A" -> seatId. Used to map critiques back to seats. */
export function seatByLetter(letters: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [seatId, letter] of Object.entries(letters)) out[letter] = seatId;
  return out;
}
