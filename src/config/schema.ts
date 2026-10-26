import { z } from 'zod';
import { EFFORTS } from '../providers/types.js';

export const EffortSchema = z.enum(EFFORTS);

const PricingSchema = z.object({
  input: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  output: z.number().nonnegative(),
});

const ProviderBase = z.object({
  /** Model family for cache-aware decisions; inferred from the model id when omitted. */
  family: z.string().optional(),
  /** Slopalytics family slug used for catalog lookups, e.g. "claude-opus-5-5". */
  catalogId: z.string().optional(),
  /** USD per 1M tokens; overrides catalog pricing. */
  pricing: PricingSchema.optional(),
  /** Map our effort scale onto what this provider accepts (e.g. deepseek: xhigh -> high). */
  effortMap: z.partialRecord(EffortSchema, z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});

export const LiteLLMProviderSchema = ProviderBase.extend({
  kind: z.literal('litellm'),
  /** LiteLLM model_name (alias in the proxy's model_list). */
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Extra body params forwarded to the proxy. */
  extraBody: z.record(z.string(), z.unknown()).optional(),
});

export const CliProviderSchema = ProviderBase.extend({
  kind: z.literal('cli'),
  /** Built-in preset: claude-code | opencode | antigravity. Omit to fully specify command/args. */
  preset: z.enum(['claude-code', 'opencode', 'antigravity']).optional(),
  model: z.string(),
  command: z.string().optional(),
  /** Arg template; placeholders: {model} {prompt} {effort} {sessionId}. */
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** How to parse stdout: plain text or a JSON object with a text field. */
  output: z.enum(['text', 'claude-json', 'opencode-json']).optional(),
});

export const MockProviderSchema = ProviderBase.extend({
  kind: z.literal('mock'),
  model: z.string().default('mock'),
  reply: z.string().optional(),
  failRate: z.number().min(0).max(1).default(0),
  latencyMs: z.number().int().nonnegative().default(0),
});

export const ProviderConfigSchema = z.discriminatedUnion('kind', [
  LiteLLMProviderSchema,
  CliProviderSchema,
  MockProviderSchema,
]);
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type LiteLLMProviderConfig = z.infer<typeof LiteLLMProviderSchema>;
export type CliProviderConfig = z.infer<typeof CliProviderSchema>;
export type MockProviderConfig = z.infer<typeof MockProviderSchema>;

export const TierSchema = z.object({
  /** Shown to Jev as the option description for the complexity choice. */
  description: z.string(),
  effort: EffortSchema.default('medium'),
  /** Ordered provider ids: first healthy one wins, the rest are fallbacks. */
  targets: z.array(z.string()).min(1),
});
export type TierConfig = z.infer<typeof TierSchema>;

export const ConfigSchema = z.object({
  jev: z.object({
    baseUrl: z.string().default('https://opencode.ai/zen/v1'),
    apiKey: z.string().optional(),
    model: z.string().default('jev-1.13-free'),
    timeoutMs: z.number().int().positive().default(3000),
    maxRetries: z.number().int().nonnegative().default(1),
    circuitBreakerThreshold: z.number().int().nonnegative().default(3),
    circuitBreakerCooldownMs: z.number().int().nonnegative().default(30_000),
    enabled: z.boolean().default(true),
  }),
  classifier: z
    .object({
      contextWindowTurns: z.number().int().positive().default(3),
      contextBudgetChars: z.number().int().positive().default(8000),
      includeAssistantTurns: z.boolean().default(false),
      /** Below this choice confidence the default tier is used. */
      minTierConfidence: z.number().min(0).max(1).default(0.65),
      /** Risk score (0-based level index) at/above which human approval is required. */
      approvalRiskScore: z.number().nonnegative().default(1.65),
      minRiskConfidence: z.number().min(0).max(1).default(0.6),
      /** noul probability at/above which context is pruned for the handoff. */
      pruneThreshold: z.number().min(0).max(1).default(0.75),
      /** noul values inside this band are treated as "unknown". */
      uncertainBand: z.tuple([z.number(), z.number()]).default([0.3, 0.7]),
      riskRubric: z.array(z.string()).min(2).max(10).optional(),
    })
    .prefault({}),
  routing: z
    .object({
      defaultTier: z.string(),
      /** Deterministic escalation: N consecutive test failures -> escalateTier. */
      escalateOnConsecutiveFailures: z.number().int().positive().default(3),
      escalateTier: z.string().optional(),
      /** Diff size (lines) above which tier is raised at least to this tier. */
      largeDiffLines: z.number().int().positive().default(800),
      largeDiffTier: z.string().optional(),
      /** Ordered from cheapest to most capable; used for escalation / "at least" comparisons. */
      tierOrder: z.array(z.string()).min(1),
      /** Prefer the session's current (warm cache) provider when switching would cost more. */
      cacheAware: z.boolean().default(true),
    }),
  tiers: z.record(z.string(), TierSchema),
  providers: z.record(z.string(), ProviderConfigSchema),
  catalog: z
    .object({
      enabled: z.boolean().default(true),
      cacheDir: z.string().optional(),
      maxAgeHours: z.number().positive().default(24),
      slopalyticsUrl: z.string().default('https://slopalytics.com'),
    })
    .prefault({}),
  telemetry: z
    .object({
      /** JSONL decision log path; empty disables. */
      logFile: z.string().default('logs/decisions.jsonl'),
      logState: z.boolean().default(true),
    })
    .prefault({}),
});

export type JevRoutingConfig = z.infer<typeof ConfigSchema>;
export type JevRoutingConfigInput = z.input<typeof ConfigSchema>;
