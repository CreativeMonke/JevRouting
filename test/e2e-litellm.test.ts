// End-to-end: the shipped jev.config.yaml (LiteLLM-backed) + real provider registry +
// a mock LiteLLM proxy + a fake Jev endpoint. Verifies what actually goes over the wire.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { parseConfig } from '../src/config/load.js';
import { JevClient } from '../src/jev/index.js';
import { createProviders } from '../src/providers/index.js';
import { Router } from '../src/router/engine.js';
import { fakeCatalog } from './helpers/fake-catalog.js';
import { startMockLiteLLM, type MockLiteLLM } from './helpers/mock-litellm.js';

const answers = (difficulty: number[]) => ({
  model: 'jev-1.13.0',
  answers: {
    difficulty: { type: 'score', score: 0, legend: {}, probabilities: difficulty, confidence: 0.9 },
    outputSize: { type: 'score', score: 1, legend: {}, probabilities: [0, 1, 0, 0], confidence: 0.9 },
    agentic: { type: 'noul', noul: 0.1 },
    needsHistory: { type: 'noul', noul: 0.1 },
    risk: { type: 'score', score: 0.5, legend: {}, probabilities: [0.5, 0.5, 0, 0], confidence: 0.9 },
  },
});

describe('e2e: jev.config.yaml through a mock LiteLLM proxy', () => {
  let litellm: MockLiteLLM;
  beforeAll(async () => {
    litellm = await startMockLiteLLM({ models: [] });
  });
  afterAll(() => litellm.close());

  function router(difficulty: number[]) {
    const env = { LITELLM_BASE_URL: litellm.url, LITELLM_API_KEY: 'sk-test-litellm-key-123456' };
    const raw = parse(readFileSync('jev.config.yaml', 'utf8'));
    const config = parseConfig({ ...raw, telemetry: { logFile: '' } }, env);
    const fetch = vi.fn(async () => new Response(JSON.stringify(answers(difficulty)), { status: 200 }));
    const jev = new JevClient({ baseUrl: 'https://jev.test/v1', model: 'jev-test', fetch });
    // Exercise only metered/subscription Claude + free models the fake catalog knows about.
    return new Router({ config, providers: createProviders(config.providers, env), catalog: fakeCatalog(), jev, log: () => {} });
  }

  it('routes a trivial task to a cheap model with the LiteLLM alias, effort and session header', async () => {
    const r = router([1, 0, 0, 0, 0, 0]);
    const res = await r.run({ prompt: 'say hi', sessionId: 'sess-e2e' });
    expect(res.result).toBeDefined();
    const req = litellm.requests.at(-1)!;
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.headers['x-litellm-session-id']).toBe('sess-e2e');
    expect(req.headers.authorization).toBe('Bearer sk-test-litellm-key-123456');
    expect(req.body!.model).not.toBe('claudecode/claude-opus-5-5');
    expect(req.body!.reasoning_effort).toBeDefined();
  });

  it('routes a frontier task to Opus via its LiteLLM alias', async () => {
    const r = router([0, 0, 0, 0, 0.1, 0.9]);
    const res = await r.run({ prompt: 'design a multi-region consensus layer', sessionId: 'sess-e2e-2' });
    expect(res.result?.providerId).toBe('claude-opus');
    expect(litellm.requests.at(-1)!.body!.model).toBe('claudecode/claude-opus-5-5');
  });

  it('falls back to the next provider when LiteLLM returns 429 for the winner', async () => {
    const r = router([0, 0, 0, 0, 0.1, 0.9]);
    litellm.failNext('claudecode/claude-opus-5-5', 429);
    const res = await r.run({ prompt: 'design a multi-region consensus layer', sessionId: 'sess-e2e-3' });
    expect(res.attempts[0]).toMatchObject({ providerId: 'claude-opus', ok: false });
    expect(res.result).toBeDefined();
    expect(res.result!.providerId).not.toBe('claude-opus');
    // the 429 put Opus in cooldown rather than counting as a model failure
    expect(r.outcomes.coolingDown('claude-opus')).toBeDefined();
  });
});
