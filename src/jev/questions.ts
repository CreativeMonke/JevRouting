import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from './types.js';

export function noul(instructions: string): NoulQuestion {
  return { type: 'noul', instructions };
}

export function choice<const C extends Record<string, string | null>>(
  instructions: string,
  criteria: C,
): ChoiceQuestion & { criteria: C } {
  const n = Object.keys(criteria).length;
  if (n < 1) throw new RangeError('choice() needs at least 1 option');
  if (n > 255) throw new RangeError('choice() supports at most 255 options per question');
  return { type: 'choice', instructions, criteria };
}

export function score(instructions: string, criteria: string[]): ScoreQuestion {
  if (criteria.length < 2 || criteria.length > 10) {
    throw new RangeError('score() rubric must have 2..10 levels');
  }
  return { type: 'score', instructions, criteria };
}
