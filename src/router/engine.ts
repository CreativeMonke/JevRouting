import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JevRoutingConfig } from '../config/schema.js';
import { JevClient, JevError } from '../jev/index.js';
import { ProviderError, type ChatMessage, type CompletionResult, type Provider } from '../providers/types.js';
import { assessHeuristic, assessWithJev, type FitOption } from './assess.js';
import { OutcomeStore } from './outcomes.js';
import { buildPlan, rankCandidates } from './rank.js';
import { SessionStore } from './session.js';
import { estimateTokens } from './state.js';
import type { Assessment, CatalogLookup, RoutingDecision, TaskInput } from './types.js';

export interface RouterDeps {
  config: JevRoutingConfig;
  providers: Map<string, Provider>;
  catalog?: CatalogLookup;
  jev?: JevClient;
  sessions?: SessionStore;
  outcomes?: OutcomeStore;
  /** Override decision log sink (default: JSONL file from config). */
  log?: (row: Record<string, unknown>) => void;
  now?: () => number;
}

export interface RunResult {
  decision: RoutingDecision;
  result?: CompletionResult;
  attempts: Array<{ providerId: string; effort: string; ok: boolean; error?: string; latencyMs?: number }>;
  needsApproval?: boolean;
}

export class Router {
  readonly sessions: SessionStore;
  readonly outcomes: OutcomeStore;
  private readonly jev?: JevClient;

  constructor(private readonly deps: RouterDeps) {
    this.sessions = deps.sessions ?? new SessionStore();
    this.outcomes = deps.outcomes ?? new OutcomeStore();
    const j = deps.config.jev;
    this.jev =
      deps.jev ??
      (j.enabled
        ? new JevClient({
            baseUrl: j.baseUrl,
            apiKey: j.apiKey,
            model: j.model,
            timeoutMs: j.timeoutMs,
            maxRetries: j.maxRetries,
            circuitBreakerThreshold: j.circuitBreakerThreshold,
            circuitBreakerCooldownMs: j.circuitBreakerCooldownMs,
          })
        : undefined);
  }

  private fitOptions(): FitOption[] {
    const only = new Set(this.deps.config.routing.only);
    return Object.entries(this.deps.config.providers)
      .filter(([id, p]) => p.enabled && p.strengths && (!only.size || only.has(id)))
      .map(([id, p]) => ({ id, strengths: p.strengths! }));
  }

  async assess(task: TaskInput): Promise<Assessment> {
    const cfg = this.deps.config;
    const facts = { ...task.facts };
    if (task.sessionId && facts.consecutiveTestFailures === undefined) {
      const fails = this.sessions.get(task.sessionId).consecutiveFailures;
      if (fails) facts.consecutiveTestFailures = fails;
    }
    const t = { ...task, facts };
    if (!this.jev || this.jev.circuitOpen) return assessHeuristic(t, cfg);
    try {
      return await assessWithJev(this.jev, t, cfg, this.fitOptions());
    } catch (err) {
      const a = assessHeuristic(t, cfg);
      a.jev = { model: this.jev.model, latencyMs: 0, error: err instanceof JevError ? err.message : String(err) };
      return a;
    }
  }

  async decide(task: TaskInput): Promise<RoutingDecision> {
    const cfg = this.deps.config;
    const assessment = await this.assess(task);
    const pruneContext =
      (task.history?.length ?? 0) > 0 && assessment.needsHistory < cfg.classifier.historyThreshold;
    const candidates = rankCandidates(task, assessment, this.ctx(), pruneContext);

    let plan = buildPlan(candidates, cfg.routing.fallback);
    if (task.forceProvider) {
      const forced = candidates.find((c) => c.providerId === task.forceProvider);
      plan = [{ providerId: task.forceProvider, effort: task.forceEffort ?? forced?.effort ?? 'medium' }];
    }
    return { assessment, candidates, plan, pruneContext };
  }

  private ctx() {
    return {
      cfg: this.deps.config,
      catalog: this.deps.catalog,
      sessions: this.sessions,
      outcomes: this.outcomes,
    };
  }

  /** Decide, then execute the plan with fallbacks. */
  async run(task: TaskInput, opts: { approve?: boolean; dryRun?: boolean; cwd?: string } = {}): Promise<RunResult> {
    const decision = await this.decide(task);
    const sessionId = task.sessionId ?? randomUUID();
    const attempts: RunResult['attempts'] = [];

    if (decision.assessment.requireApproval && !opts.approve) {
      this.logDecision(task, decision, attempts, { needsApproval: true });
      return { decision, attempts, needsApproval: true };
    }
    if (opts.dryRun) {
      this.logDecision(task, decision, attempts, { dryRun: true });
      return { decision, attempts };
    }

    const messages = this.messagesFor(task, decision.pruneContext);
    const ctxTokens = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    for (const step of decision.plan) {
      const provider = this.deps.providers.get(step.providerId);
      if (!provider) {
        attempts.push({ ...step, ok: false, error: 'provider not configured' });
        continue;
      }
      try {
        const result = await provider.complete({ messages, effort: step.effort, sessionId, cwd: opts.cwd });
        attempts.push({ ...step, ok: true, latencyMs: result.latencyMs });
        this.sessions.record(sessionId, step.providerId, ctxTokens + (result.usage?.outputTokens ?? 0), true);
        this.outcomes.record(step.providerId, step.effort, true);
        this.logDecision(task, decision, attempts, { result: summarize(result) });
        return { decision, result, attempts };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        attempts.push({ ...step, ok: false, error: msg });
        // Quota / auth errors aren't the model's fault; don't penalise its reliability.
        if (!(err instanceof ProviderError && /limit|quota|sign.?in|auth/i.test(msg))) {
          this.outcomes.record(step.providerId, step.effort, false);
        }
        if (err instanceof ProviderError && !err.retryable) continue;
      }
    }
    this.sessions.record(sessionId, decision.plan[0]?.providerId ?? 'none', ctxTokens, false);
    this.logDecision(task, decision, attempts, { failed: true });
    return { decision, attempts };
  }

  /** Report a task outcome after the fact (e.g. tests failed on the produced change). */
  feedback(providerId: string, effort: string, ok: boolean, sessionId?: string) {
    this.outcomes.record(providerId, effort, ok);
    if (sessionId && !ok) this.sessions.get(sessionId).consecutiveFailures++;
  }

  private messagesFor(task: TaskInput, prune: boolean): ChatMessage[] {
    const history = prune ? [] : (task.history ?? []);
    return [...history, { role: 'user', content: task.prompt }];
  }

  private logDecision(
    task: TaskInput,
    d: RoutingDecision,
    attempts: RunResult['attempts'],
    extra: Record<string, unknown>,
  ) {
    const t = this.deps.config.telemetry;
    const row: Record<string, unknown> = {
      ts: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
      sessionId: task.sessionId,
      promptHash: createHash('sha256').update(task.prompt).digest('hex').slice(0, 16),
      ...(t.logState ? { prompt: task.prompt.slice(0, 2000) } : {}),
      assessment: d.assessment,
      pruneContext: d.pruneContext,
      plan: d.plan,
      candidates: d.candidates.slice(0, 12).map((c) => ({
        id: c.providerId, effort: c.effort, I: c.intelligence, p: round(c.pSuccess), cost: round(c.attemptCost, 5),
        obj: round(c.objective, 5), warm: c.cacheWarm, ok: c.eligible,
      })),
      attempts,
      ...extra,
    };
    if (this.deps.log) return this.deps.log(row);
    if (!t.logFile) return;
    try {
      mkdirSync(dirname(t.logFile), { recursive: true });
      appendFileSync(t.logFile, `${JSON.stringify(row)}\n`);
    } catch {
      // Logging must never break routing.
    }
  }
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

function summarize(r: CompletionResult) {
  return { providerId: r.providerId, model: r.model, latencyMs: r.latencyMs, usage: r.usage, costUsd: r.costUsd, chars: r.text.length };
}
