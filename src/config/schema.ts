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
  /** Efforts this provider may be run at (subset of low..max). Default: all efforts the catalog has. */
  efforts: z.array(EffortSchema).optional(),
  /**
   * metered: pay list price. subscription: prepaid seat/quota (e.g. Claude Code Max, Antigravity).
   * free: zero marginal cost (e.g. OpenCode free models).
   */
  billing: z.enum(['metered', 'subscription', 'free']).default('metered'),
  /** Multiplier on list-price cost for ranking. Defaults: metered 1, subscription 0.15, free 0.02. */
  costMultiplier: z.number().nonnegative().optional(),
  /** Prompt-cache TTL in seconds; inferred from family when omitted (anthropic 300, openai 1800, google 300, deepseek 14400). */
  cacheTtlSec: z.number().int().nonnegative().optional(),
  /** Qualitative strengths shown to Jev when it is asked to pick a model (no numbers: Jev can't do math). */
  strengths: z.string().optional(),
  /** Static priors when the catalog has no data for this model. */
  intelligence: z.number().optional(),
  costPerTask: z.number().optional(),
  /**
   * Fixed tokens the backend adds to every call (agent system prompt + tool schemas).
   * Defaults: CLI presets claude-code 17500, opencode 9000, antigravity 12000; litellm 0.
   * Set it for LiteLLM models that front an agent harness.
   */
  harnessTokens: z.number().int().nonnegative().optional(),
  /** Hard cap: never route here for tasks needing more than this intelligence (e.g. tiny free models). */
  maxIntelligence: z.number().optional(),
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

export const ConfigSchema = z.object({
  jev: z.object({
    /** Optional primary backend; most configs list everything under `backends` instead. */
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    timeoutMs: z.number().int().positive().default(3000),
    maxRetries: z.number().int().nonnegative().default(1),
    circuitBreakerThreshold: z.number().int().nonnegative().default(3),
    circuitBreakerCooldownMs: z.number().int().nonnegative().default(30_000),
    enabled: z.boolean().default(true),
    /**
     * Extra Jev-compatible backends tried in order after the primary one (failover on
     * 429 / timeouts / breaker). A backend whose required fields are empty is skipped,
     * so you can leave e.g. Cloudflare in the config and enable it just by setting env vars.
     */
    backends: z
      .array(
        z.object({
          name: z.string().optional(),
          transport: z.enum(['systemone', 'workers-ai']).default('systemone'),
          baseUrl: z.string().optional(),
          apiKey: z.string().optional(),
          model: z.string(),
          /** Skip unless this is set (e.g. a Cloudflare account id). */
          requires: z.array(z.string().optional()).optional(),
          timeoutMs: z.number().int().positive().optional(),
        }),
      )
      .default([]),
  }),
  classifier: z
    .object({
      contextWindowTurns: z.number().int().positive().default(3),
      contextBudgetChars: z.number().int().positive().default(8000),
      includeAssistantTurns: z.boolean().default(false),
      /**
       * Quantile of Jev's difficulty distribution used as the required level.
       * 0.5 = median (cheaper), 0.8 = conservative (default).
       */
      difficultyQuantile: z.number().min(0).max(1).default(0.8),
      /** Below this confidence on taskKind, fall back to "implement". */
      minKindConfidence: z.number().min(0).max(1).default(0.5),
      /** Risk score (0-based level index, 0..3) at/above which human approval is required. */
      approvalRiskScore: z.number().nonnegative().default(2.5),
      /** Each risk level above 0 adds this many intelligence points to the requirement. */
      riskIntelligenceBump: z.number().nonnegative().default(2),
      /** noul probability at/above which history is considered needed. */
      historyThreshold: z.number().min(0).max(1).default(0.5),
      /** Also ask Jev for task kind + latency preference (cheap on hosted Jev; slower on local Clef). */
      extendedQuestions: z.boolean().default(false),
      /** Ask Jev to pick among candidate models too (qualitative fit prior). */
      askModelFit: z.boolean().default(true),
      /** Weight of Jev's model-fit probability in ranking (0 disables). */
      modelFitWeight: z.number().min(0).max(1).default(0.25),
      /** Override the 4-level risk rubric. */
      riskRubric: z.array(z.string()).min(2).max(10).optional(),
    })
    .prefault({}),
  routing: z
    .object({
      /**
       * Required Intelligence Index per difficulty level (rubric index 0..5).
       * Calibrated against Slopalytics/AA: trivial ~20, frontier ~55.
       */
      intelligenceByLevel: z.array(z.number()).length(6).default([18, 28, 36, 44, 50, 55]),
      /** Logistic spread (index points) for P(success) as a function of intelligence margin. */
      successSpread: z.number().positive().default(4),
      /** Minimum P(success) for a candidate to be eligible. */
      minSuccess: z.number().min(0).max(1).default(0.6),
      /** Ranking objective: expected cost per successful task, plus weights for time. */
      latencyWeightUsdPerMin: z.number().nonnegative().default(0.004),
      /** Prefer staying on the session's warm-cache provider when switching would cost more. */
      cacheAware: z.boolean().default(true),
      /** Deterministic escalation: N consecutive test failures raise the difficulty level by one. */
      escalateOnConsecutiveFailures: z.number().int().positive().default(2),
      /** How long a provider is skipped after a quota / rate-limit / sign-in failure (unless it says Retry-After). */
      providerCooldownSec: z.number().int().positive().default(900),
      /** Fallback provider ids (ordered) used when everything else fails or Jev is down. */
      fallback: z.array(z.string()).default([]),
      /** Restrict routing to these provider ids (empty = all enabled). */
      only: z.array(z.string()).default([]),
    })
    .prefault({}),
  providers: z.record(z.string(), ProviderConfigSchema),
  catalog: z
    .object({
      enabled: z.boolean().default(true),
      cacheDir: z.string().optional(),
      maxAgeHours: z.number().positive().default(24),
      slopalyticsUrl: z.string().default('https://slopalytics.com'),
      /** Data sources, merged in order: Slopalytics is primary; the others only fill gaps. */
      sources: z
        .object({
          slopalytics: z.object({ enabled: z.boolean().default(true) }).prefault({}),
          /** models.dev: public pricing incl. cache read/write, context, effort levels. */
          modelsDev: z
            .object({ enabled: z.boolean().default(true), url: z.string().default('https://models.dev/api.json') })
            .prefault({}),
          /** Artificial Analysis API: intelligence scores for models Slopalytics lacks (needs a key). */
          artificialAnalysis: z
            .object({
              enabled: z.boolean().default(false),
              apiKey: z.string().optional(),
              url: z.string().default('https://artificialanalysis.ai/api/v2/data/llms/models'),
            })
            .prefault({}),
        })
        .prefault({}),
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
