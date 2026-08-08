import type { TaskClassification, TaskType } from '@consensus/shared';
import { DEBATABLE_TASK_TYPES } from '@consensus/shared';

/**
 * Task-type gating.
 *
 * Consensus is meaningless for creative and opinion prompts — four different
 * poems are not a disagreement, and forcing a debate over them wastes the
 * user's scarcest resource (subscription quota) to manufacture a fake verdict.
 *
 * The heuristic runs first because it is free and instant. Only when it is
 * unsure does the caller pay for an LLM classification. The user can always
 * override, and the override is what gets persisted.
 */

interface Signal {
  type: TaskType;
  weight: number;
  re: RegExp;
  why: string;
}

const SIGNALS: Signal[] = [
  // --- creative ------------------------------------------------------------
  // Allow for determiners and adjectives: "write me a short poem", "compose
  // three funny limericks". Matching only the bare noun missed almost every
  // real phrasing.
  { type: 'creative', weight: 3.5, re: /\b(write|compose|draft|tell)\s+(?:me\s+)?(?:\w+\s+){0,4}?(poems?|songs?|lyrics?|stor(?:y|ies)|novels?|screenplays?|haikus?|limericks?|sonnets?|jokes?|essays?)\b/i, why: 'asks for a creative text' },
  { type: 'creative', weight: 2.5, re: /\b(brainstorm|come up with|suggest|generate)\s+(?:\w+\s+){0,3}?(names?|ideas?|titles?|slogans?|taglines?|concepts?)\b/i, why: 'open-ended ideation' },
  { type: 'creative', weight: 2, re: /\b(in the style of|creative|imaginative|fictional|make up a)\b/i, why: 'creative framing' },
  { type: 'creative', weight: 1.5, re: /\b(rewrite|rephrase|reword|paraphrase)\b.*\b(tone|voice|style|friendlier|punchier)\b/i, why: 'stylistic rewrite' },

  // --- opinion -------------------------------------------------------------
  { type: 'opinion', weight: 2.5, re: /\b(what do you think|your opinion|do you prefer|how do you feel)\b/i, why: 'asks for a preference' },
  { type: 'opinion', weight: 2, re: /\b(should i|would you recommend|is it worth|what would you do)\b/i, why: 'advice with no determinate answer' },
  { type: 'opinion', weight: 1.5, re: /\b(best|worst|favourite|favorite|most beautiful|coolest|prettiest)\b/i, why: 'superlative of taste' },

  // --- code ----------------------------------------------------------------
  { type: 'code', weight: 3, re: /```/, why: 'contains a code block' },
  { type: 'code', weight: 2.5, re: /\b(why (does|doesn'?t) this (code|function|script)|fix this (bug|code|error)|stack ?trace|segfault|compile error|type ?error)\b/i, why: 'debugging request' },
  { type: 'code', weight: 2, re: /\b(function|class|method|variable|api|endpoint|query|regex|algorithm|compiles?|refactor)\b/i, why: 'programming vocabulary' },
  { type: 'code', weight: 2, re: /\b(python|javascript|typescript|rust|golang|java|c\+\+|sql|bash|react|node(?:\.js)?)\b/i, why: 'names a language or framework' },

  // --- computational -------------------------------------------------------
  { type: 'computational', weight: 3, re: /\b(calculate|compute|solve|evaluate|derive|integrate|differentiate)\b/i, why: 'asks for a calculation' },
  { type: 'computational', weight: 2.5, re: /\d+\s*[-+*/^×÷]\s*\d+/, why: 'contains an arithmetic expression' },
  { type: 'computational', weight: 2, re: /\b(how many|how much|what percentage|probability|average|median|sum of|square root)\b/i, why: 'quantitative question' },
  { type: 'computational', weight: 1.5, re: /\$|\\frac|\\sum|\\int|\\sqrt/, why: 'contains mathematical notation' },

  // --- factual -------------------------------------------------------------
  { type: 'factual', weight: 2, re: /\b(who|what|when|where|which)\s+(is|are|was|were|did|does|do)\b/i, why: 'direct factual question' },
  { type: 'factual', weight: 2, re: /\b(how many|in what year|what year|the capital of|the population of|born|died|founded)\b/i, why: 'asks for a checkable fact' },
  { type: 'factual', weight: 1.5, re: /\b(is it true|is it safe|does .* cause|side effects?|dosage|interact)\b/i, why: 'verifiable claim' },
  { type: 'factual', weight: 1, re: /\b(define|definition of|what does .* mean|explain)\b/i, why: 'explanatory question' },
];

const CONFIDENCE_FLOOR = 0.55;

export function classifyHeuristic(prompt: string): TaskClassification {
  const scores: Record<TaskType, number> = {
    factual: 0.4, // mild prior: a question with no other signal is usually factual
    computational: 0,
    code: 0,
    creative: 0,
    opinion: 0,
  };
  const reasons: Partial<Record<TaskType, string>> = {};

  for (const s of SIGNALS) {
    if (!s.re.test(prompt)) continue;
    scores[s.type] += s.weight;
    if (!reasons[s.type]) reasons[s.type] = s.why;
  }

  const ranked = (Object.entries(scores) as Array<[TaskType, number]>).sort((a, b) => b[1] - a[1]);
  const first = ranked[0] ?? (['factual', 0] as [TaskType, number]);
  const second = ranked[1] ?? (['factual', 0] as [TaskType, number]);

  const total = ranked.reduce((n, [, v]) => n + v, 0) || 1;
  const margin = (first[1] - second[1]) / total;
  const confidence = Math.max(0, Math.min(0.95, 0.4 + margin * 1.4));

  return {
    type: first[0],
    confidence: Number(confidence.toFixed(2)),
    rationale: reasons[first[0]] ?? 'no strong signal; defaulted to a checkable question',
    source: 'heuristic',
  };
}

/** True when the heuristic is too close to call and an LLM pass is worth paying for. */
export function needsLlmClassification(c: TaskClassification): boolean {
  return c.source === 'heuristic' && c.confidence < CONFIDENCE_FLOOR;
}

export function isDebatable(c: TaskClassification | null, forceDebate: boolean): boolean {
  if (forceDebate) return true;
  if (!c) return true;
  return DEBATABLE_TASK_TYPES.includes(c.type);
}

/** Parse the LLM classifier's fenced reply. Falls back to the heuristic on anything odd. */
export function parseClassification(raw: string, fallback: TaskClassification): TaskClassification {
  const fence = raw.match(/```[ \t]*verdict[ \t]*\r?\n([\s\S]*?)```/i);
  const body = fence?.[1] ?? raw;
  const objMatch = body.match(/\{[\s\S]*\}/);
  if (!objMatch) return fallback;
  try {
    const parsed = JSON.parse(objMatch[0]) as Partial<{ type: string; confidence: number; rationale: string }>;
    const type = String(parsed.type ?? '').toLowerCase() as TaskType;
    if (!['factual', 'computational', 'code', 'creative', 'opinion'].includes(type)) return fallback;
    return {
      type,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.7))),
      rationale: String(parsed.rationale ?? '').slice(0, 300) || 'classified by model',
      source: 'llm',
    };
  } catch {
    return fallback;
  }
}
