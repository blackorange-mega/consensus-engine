import type { ConsensusReport, JudgeKind, RunSettings, TaskType } from '@consensus/shared';

/** One seat's position, as handed to a judge. */
export interface JudgeInput {
  seatId: string;
  letter: string;
  answer: string;
  /** Declared by the model, or derived from the prose when it did not supply one. */
  answerKey: string;
  keyWasDerived: boolean;
}

export interface JudgeContext {
  runId: string;
  round: number;
  prompt: string;
  taskType: TaskType | null;
  settings: RunSettings;
}

/**
 * The protocol layer must not care which judge is installed.
 * A judge answers exactly one question: do these answers make the same claim,
 * and if not, who is in which camp.
 */
export interface Judge {
  readonly kind: JudgeKind;
  /** False when the judge needs the user to decide (the Human judge). */
  readonly automatic: boolean;
  compare(inputs: JudgeInput[], ctx: JudgeContext): Promise<ConsensusReport>;
}

/** Shared helper: build camps from a grouping function. */
export function campsFrom(
  inputs: JudgeInput[],
  keyOf: (i: JudgeInput) => string,
  labelOf: (key: string, members: JudgeInput[]) => string,
): ConsensusReport['camps'] {
  const groups = new Map<string, JudgeInput[]>();
  for (const input of inputs) {
    const key = keyOf(input);
    const list = groups.get(key);
    if (list) list.push(input);
    else groups.set(key, [input]);
  }
  return [...groups.entries()]
    .map(([key, members]) => ({
      key,
      label: labelOf(key, members),
      seatIds: members.map((m) => m.seatId).sort(),
      representativeAnswer: members[0]?.answer ?? '',
    }))
    .sort((a, b) => b.seatIds.length - a.seatIds.length || a.key.localeCompare(b.key));
}
