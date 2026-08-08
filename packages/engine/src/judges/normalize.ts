/**
 * Answer-key normalisation and comparison.
 *
 * This is what actually decides agreement. Embedding similarity
 * is not allowed anywhere near this decision: measured on `potion-base-8M`, a
 * direct negation scores 0.988 while a correct paraphrase scores 0.246 — the
 * ranking is inverted, so no threshold can separate agreement from
 * contradiction. Exact/numeric-tolerant comparison on a short canonical key
 * does separate them, which is why the protocol asks for the key.
 */

export interface NormalizeOptions {
  /** Relative tolerance for numeric comparison. */
  tolerance: number;
}

const FILLER = [
  /^(?:the\s+)?(?:answer|result|value|solution)\s+(?:is|=|:)\s*/i,
  /^(?:it|that)\s+(?:is|'s)\s+/i,
  /^(?:i\s+(?:believe|think)\s+)?(?:the\s+answer\s+is\s+)?/i,
  /^(?:approximately|approx\.?|about|around|roughly|~)\s*/i,
];

const YES = /^(?:yes|yeah|yep|true|correct|affirmative|right|indeed|si|agreed)$/i;
const NO = /^(?:no|nope|false|incorrect|negative|wrong|nah)$/i;

/** Canonical unit families. Comparison converts within a family, never across. */
const UNITS: Record<string, { family: string; factor: number }> = {
  // length (metre)
  nm: { family: 'length', factor: 1e-9 },
  um: { family: 'length', factor: 1e-6 },
  mm: { family: 'length', factor: 1e-3 },
  cm: { family: 'length', factor: 1e-2 },
  m: { family: 'length', factor: 1 },
  metre: { family: 'length', factor: 1 },
  metres: { family: 'length', factor: 1 },
  meter: { family: 'length', factor: 1 },
  meters: { family: 'length', factor: 1 },
  km: { family: 'length', factor: 1e3 },
  in: { family: 'length', factor: 0.0254 },
  inch: { family: 'length', factor: 0.0254 },
  inches: { family: 'length', factor: 0.0254 },
  ft: { family: 'length', factor: 0.3048 },
  feet: { family: 'length', factor: 0.3048 },
  mile: { family: 'length', factor: 1609.344 },
  miles: { family: 'length', factor: 1609.344 },

  // mass (gram)
  ug: { family: 'mass', factor: 1e-6 },
  mcg: { family: 'mass', factor: 1e-6 },
  mg: { family: 'mass', factor: 1e-3 },
  g: { family: 'mass', factor: 1 },
  gram: { family: 'mass', factor: 1 },
  grams: { family: 'mass', factor: 1 },
  kg: { family: 'mass', factor: 1e3 },
  lb: { family: 'mass', factor: 453.592 },
  lbs: { family: 'mass', factor: 453.592 },
  oz: { family: 'mass', factor: 28.3495 },

  // time (second)
  ns: { family: 'time', factor: 1e-9 },
  us: { family: 'time', factor: 1e-6 },
  ms: { family: 'time', factor: 1e-3 },
  s: { family: 'time', factor: 1 },
  sec: { family: 'time', factor: 1 },
  secs: { family: 'time', factor: 1 },
  second: { family: 'time', factor: 1 },
  seconds: { family: 'time', factor: 1 },
  min: { family: 'time', factor: 60 },
  mins: { family: 'time', factor: 60 },
  minute: { family: 'time', factor: 60 },
  minutes: { family: 'time', factor: 60 },
  h: { family: 'time', factor: 3600 },
  hr: { family: 'time', factor: 3600 },
  hrs: { family: 'time', factor: 3600 },
  hour: { family: 'time', factor: 3600 },
  hours: { family: 'time', factor: 3600 },
  day: { family: 'time', factor: 86400 },
  days: { family: 'time', factor: 86400 },

  // volume (litre)
  ml: { family: 'volume', factor: 1e-3 },
  l: { family: 'volume', factor: 1 },
  litre: { family: 'volume', factor: 1 },
  litres: { family: 'volume', factor: 1 },
  liter: { family: 'volume', factor: 1 },
  liters: { family: 'volume', factor: 1 },

  // data (byte)
  b: { family: 'data', factor: 1 },
  byte: { family: 'data', factor: 1 },
  bytes: { family: 'data', factor: 1 },
  kb: { family: 'data', factor: 1e3 },
  mb: { family: 'data', factor: 1e6 },
  gb: { family: 'data', factor: 1e9 },
  tb: { family: 'data', factor: 1e12 },

  // dimensionless
  '%': { family: 'percent', factor: 1 },
  percent: { family: 'percent', factor: 1 },
};

/** Currencies are compared by symbol, never converted — 5 USD is not 5 EUR. */
const CURRENCY = /^[$€£¥₽₹]|(?:usd|eur|gbp|jpy|rub|inr|irr|toman)$/i;

export interface Quantity {
  value: number;
  unit: string | null;
  family: string | null;
  currency: string | null;
}

/** Normalise a raw key to a comparable canonical string. */
export function normalizeKey(input: string): string {
  let s = (input ?? '').normalize('NFKC').trim();

  // Strip wrapping quotes, backticks, brackets and trailing punctuation.
  s = s.replace(/^[`"'“”‘’\[\(<]+/, '').replace(/[`"'“”‘’\]\)>]+$/, '');
  s = s.replace(/[.。!！]+$/, '').trim();

  for (const re of FILLER) s = s.replace(re, '').trim();

  s = s.replace(/\s+/g, ' ').toLowerCase();

  if (YES.test(s)) return 'yes';
  if (NO.test(s)) return 'no';

  // Leading polarity is substantive and must survive normalisation.
  // "not safe" must never collapse to "safe".
  s = s.replace(/\bis not\b/g, 'not').replace(/\bisn't\b/g, 'not').replace(/\bdoes not\b/g, 'not');

  // Drop articles, which never carry a claim.
  s = s.replace(/\b(?:a|an|the)\b\s*/g, '').trim();

  // Digit separators: 1,000 / 1 000 / 1_000 -> 1000
  s = s.replace(/(\d)[,_  ](?=\d{3}\b)/g, '$1');

  return s.trim();
}

/** Parse a single numeric quantity, if the whole key is one. */
export function parseQuantity(normalised: string): Quantity | null {
  const s = normalised.trim();

  const currencyLead = s.match(/^([$€£¥₽₹])\s*(-?[\d.]+(?:e-?\d+)?)$/i);
  if (currencyLead) {
    const value = Number(currencyLead[2]);
    if (Number.isFinite(value)) {
      return { value, unit: currencyLead[1] ?? null, family: 'currency', currency: currencyLead[1] ?? null };
    }
  }

  const m = s.match(/^(-?(?:\d+(?:\.\d+)?|\.\d+)(?:e-?\d+)?)\s*([a-z%µ]+)?$/i);
  if (m) {
    const value = Number(m[1]);
    if (!Number.isFinite(value)) return null;
    const rawUnit = (m[2] ?? '').toLowerCase();
    if (!rawUnit) return { value, unit: null, family: null, currency: null };
    if (CURRENCY.test(rawUnit)) return { value, unit: rawUnit, family: 'currency', currency: rawUnit };
    const known = UNITS[rawUnit];
    if (known) return { value: value * known.factor, unit: rawUnit, family: known.family, currency: null };
    // Unknown unit: keep it, and require an exact unit match to compare.
    return { value, unit: rawUnit, family: `raw:${rawUnit}`, currency: null };
  }

  // Simple fractions: 1/2, 3 / 4
  const frac = s.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const a = Number(frac[1]);
    const b = Number(frac[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) {
      return { value: a / b, unit: null, family: null, currency: null };
    }
  }

  return null;
}

export interface KeyComparison {
  equal: boolean;
  /** How the decision was made, for the report. */
  method: 'exact' | 'numeric' | 'boolean' | 'textual' | 'empty';
  detail?: string;
}

/**
 * Decide whether two answer keys make the same claim.
 * Deliberately conservative: when in doubt, NOT equal. A false "converged" is
 * the worst failure this app can produce.
 */
export function compareKeys(a: string, b: string, opts: NormalizeOptions): KeyComparison {
  const na = normalizeKey(a);
  const nb = normalizeKey(b);

  if (!na || !nb) return { equal: false, method: 'empty', detail: 'a key was missing' };
  if (na === nb) return { equal: true, method: 'exact' };

  if ((na === 'yes' || na === 'no') && (nb === 'yes' || nb === 'no')) {
    return { equal: false, method: 'boolean', detail: `opposite polarity: ${na} vs ${nb}` };
  }

  const qa = parseQuantity(na);
  const qb = parseQuantity(nb);
  if (qa && qb) {
    if (qa.family !== qb.family) {
      return {
        equal: false,
        method: 'numeric',
        detail: `incomparable units: ${qa.unit ?? 'dimensionless'} vs ${qb.unit ?? 'dimensionless'}`,
      };
    }
    if (qa.family === 'currency' && qa.currency !== qb.currency) {
      return { equal: false, method: 'numeric', detail: `different currencies` };
    }
    const scale = Math.max(Math.abs(qa.value), Math.abs(qb.value), Number.MIN_VALUE);
    const relative = Math.abs(qa.value - qb.value) / scale;
    return relative <= opts.tolerance
      ? { equal: true, method: 'numeric' }
      : { equal: false, method: 'numeric', detail: `${qa.value} vs ${qb.value}` };
  }

  // One is a number and the other is not: not the same claim.
  if (Boolean(qa) !== Boolean(qb)) {
    return { equal: false, method: 'numeric', detail: 'one key is a quantity and the other is not' };
  }

  return { equal: false, method: 'textual', detail: `"${na}" vs "${nb}"` };
}

/**
 * Fallback when a model gives prose but no key. Best effort only: the first
 * meaningful line, stripped of markdown. Flagged so the report can say the
 * comparison rested on a derived key rather than a declared one.
 */
export function deriveKeyFromAnswer(answer: string): string {
  const withoutCode = answer.replace(/```[\s\S]*?```/g, ' ');

  const lines = withoutCode.split(/\r?\n/);
  const meaningful: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A markdown heading labels the answer, it is not the claim itself.
    if (/^#{1,6}\s/.test(trimmed)) continue;
    // Nor is a horizontal rule or a bare list bullet.
    if (/^([-*_]\s*){3,}$/.test(trimmed)) continue;
    meaningful.push(trimmed);
  }

  const firstLine = (meaningful[0] ?? withoutCode.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '')
    .replace(/^[-*+]\s+/, '')
    .replace(/[*_`>]/g, '')
    .trim();

  if (firstLine.length <= 120) return firstLine;

  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  return firstSentence.slice(0, 120);
}
