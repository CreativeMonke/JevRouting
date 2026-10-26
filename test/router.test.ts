import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { JevClient } from '../src/jev/index.js';
import type { CompletionRequest, Provider } from '../src/providers/types.js';
import { ProviderError } from '../src/providers/types.js';
import {
  assessHeuristic,
  buildJevState,
  levelDistribution,
  quantileLevel,
  rankCandidates,
  redact,
  Router,
  SessionStore,
  OutcomeStore,
  buildQuestions,
  capability,
  floorAt,
  shiftUp,
  type Assessment,
} from '../src/router/index.js';
import { fakeCatalog } from './helpers/fake-catalog.js';

const baseConfig = (overrides: Record<string, unknown> = {}) =>
  parseConfig({
    jev: { baseUrl: 'https://jev.test/v1', model: 'jev-test' },
    telemetry: { logFile: '' },
    providers: {
      opus: { kind: 'mock', model: 'claude-opus-5-5', billing: 'metered', efforts: ['medium', 'high'], strengths: 'deep reasoning' },
      sonnet: { kind: 'mock', model: 'claude-sonnet-5-5', billing: 'metered', efforts: ['low', 'medium', 'high'], strengths: 'all-round coder' },
      haiku: { kind: 'mock', model: 'claude-haiku-5-5', billing: 'metered', efforts: ['low', 'medium'], strengths: 'fast small edits' },
      glm: { kind: 'mock', model: 'opencode/glm-5.3-flash-free', billing: 'free', efforts: ['max'], maxIntelligence: 46, strengths: 'free routine coding' },
    },
    ...overrides,
  });

function assessment(partial: Partial<Assessment>): Assessment {
  return {
    source: 'jev', difficulty: [0, 0, 1, 0, 0, 0], level: 2, requiredIntelligence: 36, kind: 'implement',
    kindConfidence: 0.9, outputSize: 1, agentic: 0.5, needsHistory: 0.2, risk: 1, latencySensitive: 0.2,
    requireApproval: false, adjustments: [], ...partial,
  };
}

function jevFetch(answers: Record<string, unknown>) {
  return vi.fn(async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers }), { status: 200 }));
}

const answersFor = (difficulty: number[], extra: Record<string, unknown> = {}) => ({
  difficulty: { type: 'score', score: 0, legend: {}, probabilities: difficulty, confidence: 0.8 },
  kind: { type: 'choice', choice: 'implement', probabilities: { implement: 0.9 }, confidence: 0.8 },
  outputSize: { type: 'score', score: 1.2, legend: {}, probabilities: [0, 1, 0, 0], confidence: 0.8 },
  agentic: { type: 'noul', noul: 0.8 },
  needsHistory: { type: 'noul', noul: 0.1 },
  risk: { type: 'score', score: 0.9, legend: {}, probabilities: [0.1, 0.9, 0, 0], confidence: 0.8 },
  latencySensitive: { type: 'noul', noul: 0.1 },
  ...extra,
});

class RecordingProvider implements Provider {
  readonly kind = 'test';
  calls: CompletionRequest[] = [];
  constructor(readonly id: string, readonly model: string, readonly family = 'anthropic', private fail?: Error) {}
  async complete(req: CompletionRequest) {
    this.calls.push(req);
    if (this.fail) throw this.fail;
    return { text: `ok from ${this.id}`, providerId: this.id, model: this.model, latencyMs: 1 };
  }
}

describe('state building', () => {
  it('redacts secrets and keeps only recent user turns', () => {
    const state = buildJevState(
      {
        prompt: 'deploy with key sk-abcdefghijklmnopqrstuvwxyz123456',
        history: [
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'big code dump' },
          { role: 'user', content: 'two' },
          { role: 'user', content: 'three' },
          { role: 'user', content: 'four' },
        ],
        facts: { diffLines: 1500, consecutiveTestFailures: 3 },
      },
      { contextWindowTurns: 3, contextBudgetChars: 8000, includeAssistantTurns: false },
    );
    expect(state.task).toContain('[REDACTED]');
    expect(state.recent_user_turns).toEqual(['two', 'three', 'four']);
    expect(state.facts).toMatchObject({ diff_size: 'very large', repeated_test_failures: true, has_prior_conversation: true });
  });

  it('redact handles tokens', () => {
    expect(redact('ghp_abcdefghijklmnopqrstuvwxyz123')).toBe('[REDACTED]');
    expect(redact('AKIAABCDEFGHIJKLMNOP')).toBe('[REDACTED]');
  });
});

describe('difficulty distribution', () => {
  it('normalises dict or array probabilities and takes quantiles', () => {
    const d = levelDistribution({ type: 'score', score: 2, legend: {}, probabilities: { '1': 2, '2': 6, '4': 2 }, confidence: 1 }, 6);
    expect(d).toEqual([0, 0.2, 0.6, 0, 0.2, 0]);
    expect(quantileLevel(d, 0.5)).toBe(2);
    expect(quantileLevel(d, 0.8)).toBe(2);
    expect(quantileLevel(d, 0.81)).toBe(4);
  });
  it('falls back to point mass at the score', () => {
    expect(levelDistribution({ type: 'score', score: 3.4, legend: {}, probabilities: [], confidence: 1 }, 6)).toEqual([0, 0, 0, 1, 0, 0]);
  });
});

describe('ranking', () => {
  const cfg = baseConfig();
  const catalog = fakeCatalog();

  it('sends trivial work to the cheapest adequate model', () => {
    const ranked = rankCandidates({ prompt: 'fix typo' }, assessment({ requiredIntelligence: 28, agentic: 0.1, outputSize: 0 }), { cfg, catalog }, false);
    expect(ranked[0]!.providerId).toMatch(/glm|haiku/);
  });

  it('sends frontier work to opus and rules out models below the bar', () => {
    const ranked = rankCandidates({ prompt: 'design' }, assessment({ requiredIntelligence: 50, agentic: 0.9, outputSize: 2 }), { cfg, catalog }, false);
    expect(ranked[0]!.providerId).toBe('opus');
    expect(ranked.find((c) => c.providerId === 'glm')!.eligible).toBe(false);
    expect(ranked.find((c) => c.providerId === 'haiku')!.eligible).toBe(false);
  });

  it('picks the effort too: higher effort only when needed', () => {
    const lo = rankCandidates({ prompt: 'x' }, assessment({ requiredIntelligence: 30 }), { cfg: baseConfig({ routing: { only: ['sonnet'] } }), catalog }, false);
    const hi = rankCandidates({ prompt: 'x' }, assessment({ requiredIntelligence: 44 }), { cfg: baseConfig({ routing: { only: ['sonnet'] } }), catalog }, false);
    expect(lo[0]!.effort).toBe('low');
    expect(hi[0]!.effort).toBe('high');
  });

  it('respects maxIntelligence caps', () => {
    const ranked = rankCandidates({ prompt: 'x' }, assessment({ requiredIntelligence: 47 }), { cfg, catalog }, false);
    const glm = ranked.find((c) => c.providerId === 'glm')!;
    expect(glm.eligible).toBe(false);
    expect(glm.reasons.join()).toMatch(/cap/);
  });

  it('warm cache makes staying cheaper than switching on a big context', () => {
    let t = 1_000_000;
    const sessions = new SessionStore({ now: () => t });
    sessions.record('s1', 'opus', 400_000, true);
    const task = { prompt: 'continue', sessionId: 's1', facts: { contextTokens: 400_000 } };
    const a = assessment({ requiredIntelligence: 44, agentic: 0, outputSize: 1 });
    const cfg2 = baseConfig({ routing: { only: ['opus', 'sonnet'] } });
    const warm = rankCandidates(task, a, { cfg: cfg2, catalog, sessions }, false);
    expect(warm[0]!.providerId).toBe('opus');
    expect(warm[0]!.cacheWarm).toBe(true);
    t += 10 * 60_000; // past Anthropic 5-minute TTL
    const cold = rankCandidates(task, a, { cfg: cfg2, catalog, sessions }, false);
    expect(cold.find((c) => c.providerId === 'opus')!.cacheWarm).toBe(false);
    expect(cold[0]!.providerId).toBe('sonnet');
  });

  it('learned failures lower reliability and can flip the choice', () => {
    const outcomes = new OutcomeStore(undefined, 4);
    for (let i = 0; i < 30; i++) outcomes.record('glm', 'max', false);
    const ranked = rankCandidates({ prompt: 'x' }, assessment({ requiredIntelligence: 28, agentic: 0.2 }), { cfg, catalog, outcomes }, false);
    expect(ranked[0]!.providerId).not.toBe('glm');
  });

  it('Jev model-fit vote nudges ties', () => {
    const cfg2 = baseConfig({ routing: { only: ['sonnet', 'haiku'] } });
    const a = assessment({ requiredIntelligence: 26, agentic: 0, outputSize: 1 });
    const neutral = rankCandidates({ prompt: 'x' }, a, { cfg: cfg2, catalog }, false);
    const voted = rankCandidates({ prompt: 'x' }, { ...a, modelFit: { sonnet: 0.97, haiku: 0.03 } }, { cfg: cfg2, catalog }, false);
    const obj = (r: typeof neutral, id: string) => Math.min(...r.filter((c) => c.providerId === id).map((c) => c.objective));
    expect(obj(voted, 'sonnet')).toBeLessThan(obj(neutral, 'sonnet'));
    expect(obj(voted, 'haiku')).toBeGreaterThan(obj(neutral, 'haiku'));
  });
});

describe('question sets and distribution math', () => {
  it('extended set adds kind + latency', () => {
    expect(Object.keys(buildQuestions([], { extended: true }))).toEqual(
      expect.arrayContaining(['difficulty', 'outputSize', 'agentic', 'needsHistory', 'risk', 'kind', 'latencySensitive']),
    );
    expect(buildQuestions([])).not.toHaveProperty('kind');
  });
  it('shiftUp / floorAt move mass, keep the total', () => {
    expect(shiftUp([0.5, 0.5, 0, 0, 0, 0], 1)).toEqual([0, 0.5, 0.5, 0, 0, 0]);
    expect(shiftUp([0, 0, 0, 0, 0.5, 0.5], 1)).toEqual([0, 0, 0, 0, 0, 1]);
    floorAt([0.2, 0.3, 0.1, 0.4, 0, 0], 3).forEach((v, i) => expect(v).toBeCloseTo(i === 3 ? 1 : 0));
  });
  it('capability integrates over the distribution', () => {
    const a = assessment({ difficulty: [0, 0, 0.5, 0, 0, 0.5], requiredByLevel: [18, 28, 36, 44, 50, 55], requiredIntelligence: 55 });
    const p = capability(45, a, 4);
    // ~half the mass is easy for a 45 model, half is far out of reach
    expect(p).toBeGreaterThan(0.45);
    expect(p).toBeLessThan(0.55);
  });
});

describe('heuristic assessor', () => {
  const cfg = baseConfig();
  it('classifies obvious cases', () => {
    expect(assessHeuristic({ prompt: 'hi' }, cfg).kind).toBe('trivial');
    const hard = assessHeuristic({ prompt: 'Debug this race condition in the distributed lock service' }, cfg);
    expect(hard.level).toBeGreaterThanOrEqual(4);
    expect(assessHeuristic({ prompt: 'drop table users in production' }, cfg).risk).toBe(2);
  });
  it('escalates on repeated test failures', () => {
    const a = assessHeuristic({ prompt: 'add a button', facts: { consecutiveTestFailures: 3 } }, cfg);
    expect(a.adjustments.join()).toMatch(/consecutive test failures/);
  });
});

describe('Router', () => {
  const catalog = fakeCatalog();

  function makeRouter(fetch: ReturnType<typeof vi.fn>, providers: Provider[], cfg = baseConfig()) {
    const jev = new JevClient({ baseUrl: 'https://jev.test/v1', model: 'jev-test', fetch: fetch as any, maxRetries: 0 });
    return new Router({ config: cfg, providers: new Map(providers.map((p) => [p.id, p])), catalog, jev, log: () => {} });
  }

  it('uses Jev answers and executes on the winner', async () => {
    const fetch = jevFetch(answersFor([0, 0, 0, 0, 0.1, 0.9]));
    const opus = new RecordingProvider('opus', 'claude-opus-5-5');
    const r = makeRouter(fetch, [opus, new RecordingProvider('sonnet', 's'), new RecordingProvider('haiku', 'h'), new RecordingProvider('glm', 'g')]);
    const res = await r.run({ prompt: 'design a distributed consensus layer' });
    expect(res.decision.assessment.source).toBe('jev');
    expect(res.decision.assessment.level).toBe(5);
    expect(res.result?.providerId).toBe('opus');
    expect(opus.calls[0]!.effort).toBeDefined();
    const body = JSON.parse((fetch.mock.calls[0] as any)[1].body);
    expect(Object.keys(body.questions)).toEqual(
      ['difficulty', 'outputSize', 'agentic', 'needsHistory', 'risk', 'modelFit'],
    );
  });

  it('falls back to the heuristic when Jev is rate limited', async () => {
    const fetch = vi.fn(async () => new Response('{"error":{"message":"Free usage limit reached"}}', { status: 429 }));
    const r = makeRouter(fetch, [new RecordingProvider('glm', 'g'), new RecordingProvider('haiku', 'h'), new RecordingProvider('sonnet', 's'), new RecordingProvider('opus', 'o')]);
    const d = await r.decide({ prompt: 'write a commit message for this diff' });
    expect(d.assessment.source).toBe('heuristic');
    expect(d.assessment.jev?.error).toMatch(/429/);
  });

  it('falls through to the next provider on failure and records outcome', async () => {
    const fetch = jevFetch(answersFor([0, 0, 1, 0, 0, 0]));
    const broken = new ProviderError('boom', 'glm', true);
    const providers = [
      new RecordingProvider('glm', 'g', 'zhipu', broken),
      new RecordingProvider('haiku', 'h'),
      new RecordingProvider('sonnet', 's'),
      new RecordingProvider('opus', 'o'),
    ];
    const r = makeRouter(fetch, providers);
    const res = await r.run({ prompt: 'add a flag' });
    expect(res.attempts.length).toBeGreaterThanOrEqual(1);
    expect(res.result).toBeDefined();
    if (res.attempts[0]!.providerId === 'glm') {
      expect(res.attempts[0]!.ok).toBe(false);
      expect(r.outcomes.observations('glm', 'max').fail).toBe(1);
    }
  });

  it('requires approval for destructive tasks', async () => {
    const fetch = jevFetch(
      answersFor([0, 0, 1, 0, 0, 0], { risk: { type: 'score', score: 2.9, legend: {}, probabilities: [0, 0, 0.1, 0.9], confidence: 0.9 } }),
    );
    const opus = new RecordingProvider('opus', 'o');
    const r = makeRouter(fetch, [opus, new RecordingProvider('sonnet', 's'), new RecordingProvider('haiku', 'h'), new RecordingProvider('glm', 'g')]);
    const res = await r.run({ prompt: 'drop the users table in prod' });
    expect(res.needsApproval).toBe(true);
    expect(opus.calls).toHaveLength(0);
    const approved = await r.run({ prompt: 'drop the users table in prod' }, { approve: true });
    expect(approved.result).toBeDefined();
  });

  it('prunes history when Jev says it is not needed', async () => {
    const fetch = jevFetch(answersFor([0, 1, 0, 0, 0, 0], { needsHistory: { type: 'noul', noul: 0.05 } }));
    const ps = ['glm', 'haiku', 'sonnet', 'opus'].map((id) => new RecordingProvider(id, id));
    const r = makeRouter(fetch, ps);
    const res = await r.run({ prompt: 'write release notes', history: [{ role: 'user', content: 'long old stuff' }] });
    expect(res.decision.pruneContext).toBe(true);
    const called = ps.find((p) => p.calls.length)!;
    expect(called.calls[0]!.messages).toHaveLength(1);
  });

  it('forceProvider bypasses ranking', async () => {
    const fetch = jevFetch(answersFor([1, 0, 0, 0, 0, 0]));
    const opus = new RecordingProvider('opus', 'o');
    const r = makeRouter(fetch, [opus, new RecordingProvider('glm', 'g')]);
    const res = await r.run({ prompt: 'hi', forceProvider: 'opus', forceEffort: 'high' });
    expect(res.result?.providerId).toBe('opus');
    expect(opus.calls[0]!.effort).toBe('high');
  });
});
