import type { CatalogPricing, CatalogUsage, CatalogVariant } from '../catalog/types.js';
import type { Effort } from '../providers/types.js';

/** What the router needs from the catalog (satisfied by CatalogStore). */
export interface CatalogLookup {
  variant(family: string, effort: string): CatalogVariant | undefined;
  pricing(family: string): CatalogPricing | undefined;
  usage(family: string): CatalogUsage | undefined;
  /** Median tokensPerTask across the catalog; used to normalise verbosity. */
  medianTokensPerTask?(): number | undefined;
}

export interface TaskInput {
  prompt: string;
  /** Prior conversation, oldest first. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  sessionId?: string;
  /** Deterministic facts computed by the caller (git, CI, ...). */
  facts?: TaskFacts;
  /** Force a provider id (skips ranking). */
  forceProvider?: string;
  /** Force an effort. */
  forceEffort?: Effort;
}

export interface TaskFacts {
  diffLines?: number;
  filesTouched?: number;
  consecutiveTestFailures?: number;
  hasSpecArtifact?: boolean;
  /** Approximate tokens of context the agent will carry (files, history). */
  contextTokens?: number;
}

export const TASK_KINDS = {
  architecture: 'System or multi-service design, planning a large change, choosing approaches with trade-offs.',
  debug: 'Finding the root cause of a bug, failing test, crash, race condition or performance problem.',
  implement: 'Writing new feature code or changing behaviour across one or more files.',
  refactor: 'Restructuring or renaming existing code without changing behaviour.',
  tests: 'Writing or fixing unit, integration or end-to-end tests.',
  review: 'Reviewing a diff, auditing code for bugs, security or style.',
  docs: 'Writing documentation, READMEs, comments, changelogs, PR descriptions or commit messages.',
  question: 'Answering a question or explaining code or a concept, without changing files.',
  trivial: 'Greeting, chit-chat, formatting, a one-line edit or a lookup with an obvious answer.',
} as const;
export type TaskKind = keyof typeof TASK_KINDS;

/** Router-side view of a task, produced by Jev (or the heuristic fallback). */
export interface Assessment {
  source: 'jev' | 'heuristic';
  /** Distribution over difficulty levels 0..5. */
  difficulty: number[];
  /** Level chosen from the distribution (quantile), after deterministic adjustments. */
  level: number;
  requiredIntelligence: number;
  kind: TaskKind;
  kindConfidence: number;
  /** 0..3 expected output size level. */
  outputSize: number;
  agentic: number;
  needsHistory: number;
  /** 0..3 */
  risk: number;
  latencySensitive: number;
  /** provider id -> probability (Jev's qualitative fit vote). */
  modelFit?: Record<string, number>;
  requireApproval: boolean;
  adjustments: string[];
  jev?: { model: string; latencyMs: number; requestId?: string; costUsd?: number; error?: string };
}

export interface Candidate {
  providerId: string;
  effort: Effort;
  family: string;
  intelligence: number;
  /** P(task succeeds on first try). */
  pSuccess: number;
  /** Expected USD for one attempt (after billing multiplier). */
  attemptCost: number;
  /** List-price USD for one attempt (before billing multiplier). */
  listCost: number;
  /** attemptCost / pSuccess + latency penalty, divided by fit bonus. */
  objective: number;
  expectedMinutes: number;
  cacheWarm: boolean;
  eligible: boolean;
  reasons: string[];
}

export interface RoutingDecision {
  assessment: Assessment;
  candidates: Candidate[];
  /** Ordered provider/effort attempts (winner first). */
  plan: Array<{ providerId: string; effort: Effort }>;
  pruneContext: boolean;
}
