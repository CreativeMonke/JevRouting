import { choice, noul, score, type JevQuestions, type ScoreAnswer, type SystemOneClient } from '../jev/index.js';
import type { JevRoutingConfig } from '../config/schema.js';
import { buildJevState, estimateTokens } from './state.js';
import { TASK_KINDS, type Assessment, type TaskInput, type TaskKind } from './types.js';

export const DIFFICULTY_RUBRIC = [
  'Trivial: greeting, formatting, a one-line edit, or a lookup with an obvious answer.',
  'Simple: a small, fully specified change in one place, a short explanation, boilerplate, or a commit message.',
  'Moderate: a standard feature or bug fix in a few files with clear requirements, or ordinary tests.',
  'Hard: a multi-file change that needs understanding of an unfamiliar codebase, a non-obvious bug, or a careful review.',
  'Very hard: cross-cutting design, concurrency, performance or security problems, ambiguous requirements, or a bug that earlier attempts failed to fix.',
  'Frontier: novel algorithms, deep root-cause analysis across systems, or high-stakes architecture where mistakes are very costly.',
];

export const OUTPUT_RUBRIC = [
  'A few words or lines.',
  'A paragraph or a small code snippet.',
  'About a page, or one complete file.',
  'Several files or a long document.',
];

export const RISK_RUBRIC = [
  'Read-only: analysis, explanation, or documentation with no effect on running systems.',
  'Ordinary code changes covered by tests or easy to revert.',
  'Touches production configuration, authentication, permissions, billing, or user data.',
  'Destructive or irreversible: deleting data, destructive migrations, force-pushing, or changing live infrastructure.',
];

export interface FitOption {
  id: string;
  strengths: string;
}

export function buildQuestions(fitOptions: FitOption[], riskRubric?: string[]): JevQuestions {
  const q: JevQuestions = {
    difficulty: score(
      'How much reasoning ability does a coding assistant need to complete this task correctly on the first try?',
      DIFFICULTY_RUBRIC,
    ),
    kind: choice('What kind of task is this?', TASK_KINDS),
    outputSize: score('How much output will a good answer contain?', OUTPUT_RUBRIC),
    agentic: noul(
      'Does completing this task require an agent to take several actions, such as reading or editing multiple files or running commands?',
    ),
    needsHistory: noul(
      'Does this task depend on earlier conversation turns, such as unresolved questions, previous attempts, or context only established earlier?',
    ),
    risk: score('What is the blast radius if this task is done wrong?', riskRubric ?? RISK_RUBRIC),
    latencySensitive: noul('Does the user want a quick answer more than a thorough one?'),
  };
  if (fitOptions.length >= 2) {
    q.modelFit = choice(
      'Which assistant is the best fit for this task, judging only by the strengths described?',
      Object.fromEntries(fitOptions.map((o) => [o.id, o.strengths])),
    );
  }
  return q;
}

/** Normalise a score answer's probabilities (dict or array) to an array indexed by level. */
export function levelDistribution(ans: ScoreAnswer | undefined, levels: number): number[] {
  const dist = new Array<number>(levels).fill(0);
  if (!ans) return dist;
  const p = ans.probabilities;
  if (Array.isArray(p)) p.forEach((v, i) => i < levels && (dist[i] = v));
  else for (const [k, v] of Object.entries(p)) {
    const i = Number(k);
    if (Number.isInteger(i) && i >= 0 && i < levels) dist[i] = v;
  }
  const total = dist.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    // Fall back to a point mass at the rounded score.
    dist[Math.min(levels - 1, Math.max(0, Math.round(ans.score)))] = 1;
    return dist;
  }
  return dist.map((v) => v / total);
}

/** Smallest level whose cumulative probability reaches q. */
export function quantileLevel(dist: number[], q: number): number {
  let acc = 0;
  for (let i = 0; i < dist.length; i++) {
    acc += dist[i]!;
    if (acc >= q - 1e-9) return i;
  }
  return dist.length - 1;
}

type Cfg = Pick<JevRoutingConfig, 'classifier' | 'routing'>;

/** Turn raw signals into a final Assessment: quantile, deterministic bumps, risk, approval. */
export function finalize(
  base: Omit<Assessment, 'level' | 'requiredIntelligence' | 'requireApproval' | 'adjustments'>,
  task: TaskInput,
  cfg: Cfg,
): Assessment {
  const adjustments: string[] = [];
  let level = quantileLevel(base.difficulty, cfg.classifier.difficultyQuantile);
  const facts = task.facts ?? {};

  if ((facts.consecutiveTestFailures ?? 0) >= cfg.routing.escalateOnConsecutiveFailures) {
    level = Math.min(5, level + 1);
    adjustments.push(`+1 level: ${facts.consecutiveTestFailures} consecutive test failures`);
  }
  if ((facts.diffLines ?? 0) > 1000 && level < 3) {
    level = 3;
    adjustments.push('level>=3: diff over 1000 lines');
  }

  const table = cfg.routing.intelligenceByLevel;
  let required = table[level]!;
  // Level 1 (ordinary, test-covered changes) is the baseline; only higher risk raises the bar.
  const riskBump = Math.max(0, Math.round(base.risk) - 1) * cfg.classifier.riskIntelligenceBump;
  if (riskBump > 0) {
    required += riskBump;
    adjustments.push(`+${riskBump} intelligence: risk ${base.risk.toFixed(2)}`);
  }
  return {
    ...base,
    level,
    requiredIntelligence: required,
    requireApproval: base.risk >= cfg.classifier.approvalRiskScore,
    adjustments,
  };
}

export async function assessWithJev(
  jev: SystemOneClient,
  task: TaskInput,
  cfg: Cfg,
  fitOptions: FitOption[] = [],
): Promise<Assessment> {
  const state = buildJevState(task, cfg.classifier);
  const questions = buildQuestions(cfg.classifier.askModelFit ? fitOptions : [], cfg.classifier.riskRubric);
  const res = await jev.systemOne({ state, questions });
  const a = res.answers as Record<string, any>;

  const kindAns = a.kind;
  const kindOk = kindAns && kindAns.confidence >= cfg.classifier.minKindConfidence && kindAns.choice in TASK_KINDS;
  const risk = a.risk as ScoreAnswer | undefined;

  return finalize(
    {
      source: 'jev',
      difficulty: levelDistribution(a.difficulty, DIFFICULTY_RUBRIC.length),
      kind: kindOk ? (kindAns.choice as TaskKind) : 'implement',
      kindConfidence: kindAns?.confidence ?? 0,
      outputSize: a.outputSize?.score ?? 1,
      agentic: a.agentic?.noul ?? 0.5,
      needsHistory: a.needsHistory?.noul ?? 0.5,
      risk: risk?.score ?? 1,
      latencySensitive: a.latencySensitive?.noul ?? 0.3,
      modelFit: a.modelFit?.probabilities,
      jev: { model: res.model, latencyMs: res.latencyMs, requestId: res.requestId, costUsd: res.costUsd },
    },
    task,
    cfg,
  );
}

const KIND_PATTERNS: Array<[TaskKind, RegExp]> = [
  ['trivial', /^\s*(hi|hello|hey|thanks?|thank you|ok|yo)\b|^.{0,25}$/i],
  ['architecture', /\b(architect|design|system design|trade-?offs?|migrat(e|ion) plan|scal(e|ing|ability)|rfc)\b/i],
  ['debug', /\b(bug|debug|crash|stack ?trace|exception|fails?|failing|broken|race|deadlock|leak|regression|why does)\b/i],
  ['review', /\b(review|audit|security check|look over|critique)\b/i],
  ['tests', /\b(unit tests?|test suite|tests? for|e2e|integration tests?|coverage)\b/i],
  ['refactor', /\b(refactor|rename|restructure|clean ?up|extract)\b/i],
  ['docs', /\b(readme|docs?|documentation|changelog|commit message|pr description|release notes|comment)\b/i],
  ['question', /^\s*(what|how|why|when|where|which|explain|can you explain|is it)\b|\?\s*$/i],
];

const KIND_LEVEL: Record<TaskKind, number> = {
  trivial: 0, docs: 1, question: 1, refactor: 2, tests: 2, implement: 2, review: 3, debug: 3, architecture: 4,
};

/** Offline fallback used when Jev is disabled, rate-limited, or down. Deliberately conservative. */
export function assessHeuristic(task: TaskInput, cfg: Cfg): Assessment {
  const text = task.prompt;
  const kind = KIND_PATTERNS.find(([, re]) => re.test(text))?.[0] ?? 'implement';
  let level = KIND_LEVEL[kind];
  const tokens = estimateTokens(text);
  if (tokens > 1500 && level < 4) level++;
  if (/\b(concurren|distributed|cryptograph|security|performance|optimi[sz]e|race condition)\w*/i.test(text)) {
    level = Math.max(level, 4);
  }
  const difficulty = new Array<number>(6).fill(0);
  // Spread mass so the quantile can lean upward like a calibrated distribution would.
  difficulty[level] = 0.8;
  difficulty[Math.min(5, level + 1)] = (difficulty[Math.min(5, level + 1)] ?? 0) + 0.2;

  const risky = /\b(prod(uction)?|migrat|drop table|delete|rm -rf|force[- ]push|billing|auth|permission|secret)\w*/i.test(text);
  return finalize(
    {
      source: 'heuristic',
      difficulty,
      kind,
      kindConfidence: 0.5,
      outputSize: kind === 'trivial' ? 0 : kind === 'architecture' || kind === 'implement' ? 2 : 1,
      agentic: ['implement', 'debug', 'refactor', 'tests'].includes(kind) ? 0.7 : 0.2,
      needsHistory: (task.history?.length ?? 0) > 0 ? 0.6 : 0.1,
      risk: risky ? 2 : kind === 'question' || kind === 'docs' || kind === 'trivial' ? 0 : 1,
      latencySensitive: kind === 'trivial' || kind === 'question' ? 0.7 : 0.2,
    },
    task,
    cfg,
  );
}
