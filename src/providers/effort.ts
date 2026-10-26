import type { Effort } from './types.js';

export interface EffortTarget {
  model: string;
  family?: string;
  effortMap?: Partial<Record<Effort, string>>;
}

/** Families whose API accepts only part of our effort scale. Unlisted efforts pass through. */
const FAMILY_EFFORT_OVERRIDES: Record<string, Partial<Record<Effort, string>>> = {
  deepseek: { medium: 'high', xhigh: 'high' },
};

const FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(claude|opus|sonnet|haiku|fable)/, 'anthropic'],
  [/^(gpt|o\d)/, 'openai'],
  [/^(gemini|gemma)/, 'google'],
  [/^deepseek/, 'deepseek'],
  [/^glm/, 'zhipu'],
];

/** Infers the model family from the last path segment, so "opencode/claude-opus-5-5" -> anthropic. */
export function inferFamily(model: string): string {
  const id = model.trim().toLowerCase().split('/').pop() ?? '';
  return FAMILY_PATTERNS.find(([pattern]) => pattern.test(id))?.[1] ?? 'other';
}

export function resolveFamily(cfg: Pick<EffortTarget, 'model' | 'family'>): string {
  return cfg.family ?? inferFamily(cfg.model);
}

export function normalizeEffort(effort: Effort, cfg: EffortTarget): string;
export function normalizeEffort(effort: Effort | undefined, cfg: EffortTarget): string | undefined;
export function normalizeEffort(effort: Effort | undefined, cfg: EffortTarget): string | undefined {
  if (effort === undefined) return undefined;
  return cfg.effortMap?.[effort] ?? FAMILY_EFFORT_OVERRIDES[resolveFamily(cfg)]?.[effort] ?? effort;
}
