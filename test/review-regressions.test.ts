import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MergedCatalog } from '../src/catalog/merged.js';
import { parseConfig } from '../src/config/load.js';
import { JevClient } from '../src/jev/index.js';
import { LiteLLMProvider } from '../src/providers/litellm.js';
import type { Provider } from '../src/providers/types.js';
import { OutcomeStore, Router, SessionStore, assessHeuristic, type Assessment } from '../src/router/index.js';
import { buildPlan, rankCandidates } from '../src/router/rank.js';
import { taskFromChat } from '../src/server.js';
import { fakeCatalog } from './helpers/fake-catalog.js';

const cfgWith = (providers: Record<string, unknown>, routing: Record<string, unknown> = {}) =>
  parseConfig({ jev: { enabled: false }, telemetry: { logFile: '' }, providers, routing });

function assessment(partial: Partial<Assessment> = {}): Assessment {
  return {
    source: 'jev', difficulty: [0, 0, 1, 0, 0, 0], level: 2, requiredIntelligence: 36, kind: 'implement',
    kindConfidence: 0.9, outputSize: 1, agentic: 0.5, needsHistory: 0.2, risk: 1, latencySensitive: 0.2,
    requireApproval: false, adjustments: [], ...partial,
  };
}

const sonnetProvider = (): Provider => ({
  id: 'sonnet', kind: 'test', family: 'anthropic', model: 'claude-sonnet-5-5',
  complete: async () => ({ text: 'hi', providerId: 'sonnet', model: 'claude-sonnet-5-5', latencyMs: 1 }),
});

describe('regression: effort dimension', () => {
  it('a provider with no catalog data is not ranked at every effort tied at the lowest', () => {
    const cfg = cfgWith({ alias: { kind: 'mock', model: 'my-alias', costPerTask: 0.5, intelligence: 45 } });
    const ranked = rankCandidates({ prompt: 'x' }, assessment({ requiredIntelligence: 36 }), { cfg, catalog: fakeCatalog() }, false);
    expect(ranked.map((c) => c.effort)).toEqual(['medium']);
  });

  it('every pinned effort is kept when the only data is a secondary-source prior', () => {
    const store = { variant: () => undefined, variants: () => [], pricing: () => undefined, usage: () => undefined } as any;
    const catalog = new MergedCatalog(
      store,
      { source: 't', fetchedAt: new Date().toISOString(), variants: [], pricing: {}, usage: [] },
      { 'my-family': { family: 'my-family', source: 'models.dev', intelligence: 40, pricing: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 } } },
    );
    const cfg = cfgWith({ fam: { kind: 'mock', model: 'my-family', efforts: ['low', 'medium', 'high'] } });
    const ranked = rankCandidates({ prompt: 'x' }, assessment({ requiredIntelligence: 36 }), { cfg, catalog }, false);
    expect(ranked.map((c) => c.effort).sort()).toEqual(['high', 'low', 'medium']);
  });
});

describe('regression: fallback plan', () => {
  it('a fallback provider in cooldown is not attempted', () => {
    const cfg = cfgWith(
      { sonnet: { kind: 'mock', model: 'claude-sonnet-5-5' }, glm: { kind: 'mock', model: 'opencode/glm-5.3-flash-free', billing: 'free' } },
      { fallback: ['glm'] },
    );
    const outcomes = new OutcomeStore();
    outcomes.cooldown('glm', 60_000, 'quota');
    const ranked = rankCandidates({ prompt: 'x' }, assessment({ requiredIntelligence: 30 }), { cfg, catalog: fakeCatalog(), outcomes }, false);
    expect(buildPlan(ranked, ['glm']).map((p) => p.providerId)).not.toContain('glm');
  });

  it('a fallback provider outside routing.only is not attempted', () => {
    const cfg = cfgWith(
      { sonnet: { kind: 'mock', model: 'claude-sonnet-5-5' }, haiku: { kind: 'mock', model: 'claude-haiku-5-5' } },
      { only: ['sonnet'], fallback: ['haiku'] },
    );
    const ranked = rankCandidates({ prompt: 'x' }, assessment({ requiredIntelligence: 30 }), { cfg, catalog: fakeCatalog() }, false);
    expect(buildPlan(ranked, ['haiku']).map((p) => p.providerId)).toEqual(['sonnet']);
  });
});

describe('regression: feedback', () => {
  it('a passing feedback report clears the consecutive-failure escalation', () => {
    const router = new Router({
      config: cfgWith({ sonnet: { kind: 'mock', model: 'claude-sonnet-5-5' } }),
      providers: new Map(),
      catalog: fakeCatalog(),
      sessions: new SessionStore(),
      outcomes: new OutcomeStore(),
      log: () => {},
    });
    router.feedback('sonnet', 'medium', false, 's1');
    router.feedback('sonnet', 'medium', false, 's1');
    router.feedback('sonnet', 'medium', true, 's1');
    expect(router.sessions.get('s1').consecutiveFailures).toBe(0);
  });
});

describe('regression: persistence failures', () => {
  it('a state-write failure after a successful completion does not fail the request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-review-'));
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const router = new Router({
      config: cfgWith({ sonnet: { kind: 'mock', model: 'claude-sonnet-5-5' } }),
      providers: new Map([['sonnet', sonnetProvider()]]),
      catalog: fakeCatalog(),
      sessions: new SessionStore({ file: join(blocker, 'sessions.json') }),
      outcomes: new OutcomeStore(),
      log: () => {},
    });
    const res = await router.run({ prompt: 'add a flag', forceProvider: 'sonnet', forceEffort: 'medium' });
    expect(res.result?.text).toBe('hi');
  });
});

describe('regression: telemetry and heuristics', () => {
  it('the decision log never contains a raw secret from the prompt', async () => {
    const rows: Record<string, unknown>[] = [];
    const router = new Router({
      config: cfgWith({ sonnet: { kind: 'mock', model: 'claude-sonnet-5-5' } }),
      providers: new Map(),
      catalog: fakeCatalog(),
      log: (row) => rows.push(row),
    });
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    await router.run({ prompt: `deploy with key ${secret}` }, { dryRun: true });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it('short non-greeting prompts are not classified as trivial by the heuristic', () => {
    const cfg = cfgWith({ sonnet: { kind: 'mock', model: 'claude-sonnet-5-5' } });
    expect(assessHeuristic({ prompt: 'fix the crash on save' }, cfg).kind).not.toBe('trivial');
  });
});

describe('regression: provider and Jev error paths', () => {
  it('an empty LiteLLM completion is reported as a failure, not a success', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: null }, finish_reason: 'length' }] }), { status: 200 }));
    const p = new LiteLLMProvider('l', { kind: 'litellm', model: 'm', baseUrl: 'http://x/v1' } as any, { fetch: fetch as any });
    await expect(p.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/empty/);
  });

  it('the Jev timeout also covers reading the response body', async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const client = new JevClient({ baseUrl: 'https://jev.test/v1', model: 'm', fetch: fetch as any, timeoutMs: 50, maxRetries: 0, circuitBreakerThreshold: 0 });
    await expect(client.systemOne({ state: 'x', questions: {} })).rejects.toThrow();
  }, 2000);

  it('a non-object JSON body is a 400, not a 500', () => {
    try {
      taskFromChat(null as any, {}, ['sonnet']);
      expect.unreachable('taskFromChat should throw');
    } catch (err) {
      expect((err as { status?: number }).status).toBe(400);
    }
  });
});
