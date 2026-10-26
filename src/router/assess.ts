import { choice, noul, score, type JevQuestions, type ScoreAnswer, type SystemOneClient } from '../jev/index.js';
import type { JevRoutingConfig } from '../config/schema.js';
import { buildJevState, estimateTokens } from './state.js';
import { TASK_KINDS, type Assessment, type TaskInput, type TaskKind } from './types.js';

// Kept short on purpose: local Clef latency grows ~linearly with input tokens.
export const DIFFICULTY_RUBRIC = [
  'Trivial: greeting, formatting, one-line edit, obvious lookup.',
  'Simple: small fully specified change, short explanation, boilerplate, commit message.',
  'Moderate: standard feature, bug fix or tests in a few files with clear requirements.',
  'Hard: multi-file change in unfamiliar code, non-obvious bug, careful review.',
  'Very hard: cross-cutting design, concurrency, performance or security work, ambiguous requirements, repeated failed fixes.',
  'Frontier: novel algorithms, deep cross-system root-cause analysis, high-stakes architecture.',
];

export const OUTPUT_RUBRIC = ['A few lines.', 'A paragraph or small snippet.', 'About a page or one file.', 'Several files or a long document.'];

export const RISK_RUBRIC = [
  'Read-only: analysis, explanations, docs.',
  'Ordinary code changes, tested or easy to revert.',
  'Production config, auth, permissions, billing or user data.',
  'Destructive or irreversible: deleting data, destructive migrations, force-push, live infrastructure.',
];

export interface FitOption {
  id: string;
  strengths: string;
}

/**
 * Core questions drive the cost model. `extended` adds task kind + latency preference
 * (otherwise derived by cheap regex heuristics) for hosted Jev, where extra questions are ~free.
 */
export function buildQuestions(fitOptions: FitOption[], opts: { riskRubric?: string[]; extended?: boolean } = {}): JevQuestions {
  const q: JevQuestions = {
    difficulty: score('How capable must a coding assistant be to get this right on the first try?', DIFFICULTY_RUBRIC),
    outputSize: score('How long is a good answer?', OUTPUT_RUBRIC),
    agentic: noul('Does this need several agent actions, such as editing multiple files or running commands?'),
    needsHistory: noul('Does this depend on earlier conversation turns or previous attempts?'),
    risk: score('Blast radius if done wrong?', opts.riskRubric ?? RISK_RUBRIC),
  };
  if (opts.extended) {
    q.kind = choice('What kind of task is this?', TASK_KINDS);
    q.latencySensitive = noul('Does the user want a quick answer more than a thorough one?');
  }
  if (fitOptions.length >= 2) {
    q.modelFit = choice(
      'Which assistant fits this task best, judging only by the strengths described?',
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
/** Move probability mass up by `by` levels (deterministic escalation keeps Jev's uncertainty shape). */
export function shiftUp(dist: number[], by: number): number[] {
  const out = new Array<number>(dist.length).fill(0);
  dist.forEach((p, i) => (out[Math.min(dist.length - 1, i + by)]! += p));
  return out;
}

/** Ensure at least `min` level: mass below it is moved to `min`. */
export function floorAt(dist: number[], min: number): number[] {
  const out = dist.slice();
  for (let i = 0; i < min; i++) {
    out[min]! += out[i]!;
    out[i] = 0;
  }
  return out;
}

/**
 * Turn raw signals into a final Assessment. The full difficulty distribution is kept:
 * ranking integrates P(success) over it, which is better calibrated than picking one level.
 * `level` / `requiredIntelligence` (at difficultyQuantile) are used for caps and display.
 */
export function finalize(
  base: Omit<Assessment, 'level' | 'requiredIntelligence' | 'requiredByLevel' | 'requireApproval' | 'adjustments'>,
  task: TaskInput,
  cfg: Cfg,
): Assessment {
  const adjustments: string[] = [];
  const facts = task.facts ?? {};
  let dist = base.difficulty.some((p) => p > 0) ? base.difficulty : [0, 0, 1, 0, 0, 0];

  if ((facts.consecutiveTestFailures ?? 0) >= cfg.routing.escalateOnConsecutiveFailures) {
    dist = shiftUp(dist, 1);
    adjustments.push(`+1 level: ${facts.consecutiveTestFailures} consecutive test failures`);
  }
  if ((facts.diffLines ?? 0) > 1000) {
    dist = floorAt(dist, 3);
    adjustments.push('level>=3: diff over 1000 lines');
  }

  // Level 1 (ordinary, test-covered changes) is the baseline; only higher risk raises the bar.
  const riskBump = Math.max(0, Math.round(base.risk) - 1) * cfg.classifier.riskIntelligenceBump;
  if (riskBump > 0) adjustments.push(`+${riskBump} intelligence: risk ${base.risk.toFixed(2)}`);
  const requiredByLevel = cfg.routing.intelligenceByLevel.map((x) => x + riskBump);

  const level = quantileLevel(dist, cfg.classifier.difficultyQuantile);
  return {
    ...base,
    difficulty: dist,
    level,
    requiredIntelligence: requiredByLevel[level]!,
    requiredByLevel,
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
  const questions = buildQuestions(cfg.classifier.askModelFit ? fitOptions : [], {
    riskRubric: cfg.classifier.riskRubric,
    extended: cfg.classifier.extendedQuestions,
  });
  const res = await jev.systemOne({ state, questions });
  const a = res.answers as Record<string, any>;

  const kindAns = a.kind;
  const kindOk = kindAns && kindAns.confidence >= cfg.classifier.minKindConfidence && kindAns.choice in TASK_KINDS;
  const risk = a.risk as ScoreAnswer | undefined;
  const hk = heuristicKind(task.prompt);

  return finalize(
    {
      source: 'jev',
      difficulty: levelDistribution(a.difficulty, DIFFICULTY_RUBRIC.length),
      kind: kindOk ? (kindAns.choice as TaskKind) : hk,
      kindConfidence: kindOk ? kindAns.confidence : 0.5,
      outputSize: a.outputSize?.score ?? 1,
      agentic: a.agentic?.noul ?? 0.5,
      needsHistory: a.needsHistory?.noul ?? 0.5,
      risk: risk?.score ?? 1,
      latencySensitive: a.latencySensitive?.noul ?? heuristicLatency(hk),
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

export function heuristicKind(text: string): TaskKind {
  return KIND_PATTERNS.find(([, re]) => re.test(text))?.[0] ?? 'implement';
}

const heuristicLatency = (kind: TaskKind) => (kind === 'trivial' || kind === 'question' ? 0.7 : 0.2);

/** Offline fallback used when Jev is disabled, rate-limited, or down. Deliberately conservative. */
export function assessHeuristic(task: TaskInput, cfg: Cfg): Assessment {
  const text = task.prompt;
  const kind = heuristicKind(text);
  let level = KIND_LEVEL[kind];
  const tokens = estimateTokens(text);
  if (tokens > 1500 && level < 4) level++;
  if (/\b(concurren|distributed|cryptograph|security|performance|optimi[sz]e|race condition|oauth|pkce|jwt|encrypt|consensus|lock-?free)\w*/i.test(text)) {
    level = Math.max(level, 4);
  }
  // "across N services/modules/repos" or several files named explicitly -> cross-cutting work.
  if (/\bacross\s+(\d+|several|multiple|many|all)\s+(services|modules|packages|repos|files|apps)\b/i.test(text)) {
    level = Math.max(level, 3);
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
      latencySensitive: heuristicLatency(kind),
    },
    task,
    cfg,
  );
}
