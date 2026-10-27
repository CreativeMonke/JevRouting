import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import type { CompletionRequest, Provider } from '../src/providers/types.js';
import { Router } from '../src/router/engine.js';
import { bearerMatches, createJevServer, taskFromChat } from '../src/server.js';
import { fakeCatalog } from './helpers/fake-catalog.js';

class EchoProvider implements Provider {
  readonly kind = 'test';
  readonly family = 'anthropic';
  calls: CompletionRequest[] = [];
  constructor(readonly id: string, readonly model: string) {}
  async complete(req: CompletionRequest) {
    this.calls.push(req);
    return { text: `echo:${req.messages.at(-1)!.content}`, providerId: this.id, model: this.model, latencyMs: 1, usage: { inputTokens: 5, outputTokens: 3 } };
  }
}

const cfg = parseConfig({
  jev: { enabled: false },
  telemetry: { logFile: '' },
  providers: {
    haiku: { kind: 'mock', model: 'claude-haiku-5-5', efforts: ['low', 'medium'] },
    opus: { kind: 'mock', model: 'claude-opus-5-5', efforts: ['medium', 'high'] },
  },
});

describe('auth', () => {
  it('bearerMatches is exact', () => {
    expect(bearerMatches('Bearer k1', 'k1')).toBe(true);
    expect(bearerMatches('Bearer k1x', 'k1')).toBe(false);
    expect(bearerMatches(undefined, 'k1')).toBe(false);
  });
  it('refuses an empty api key instead of running unauthenticated', () => {
    const router = new Router({ config: cfg, providers: new Map(), log: () => {} });
    expect(() => createJevServer({ router, providerIds: [], apiKey: '' })).toThrow(/empty/);
  });
});

describe('taskFromChat', () => {
  it('maps messages, system, session headers and forced models', () => {
    const t = taskFromChat(
      {
        model: 'opus',
        reasoning_effort: 'high',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'user', content: [{ type: 'text', text: 'c' }] },
        ],
      },
      { 'x-litellm-session-id': 'sess' },
      ['opus', 'haiku'],
    );
    expect(t.prompt).toBe('be brief\n\nc');
    expect(t.history).toEqual([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
    expect(t.sessionId).toBe('sess');
    expect(t.forceProvider).toBe('opus');
    expect(t.forceEffort).toBe('high');
  });
  it('rejects unknown models', () => {
    expect(() => taskFromChat({ model: 'nope', messages: [{ role: 'user', content: 'x' }] }, {}, ['opus'])).toThrow(/unknown model/);
  });
});

describe('OpenAI-compatible server', () => {
  const haiku = new EchoProvider('haiku', 'claude-haiku-5-5');
  const opus = new EchoProvider('opus', 'claude-opus-5-5');
  const router = new Router({ config: cfg, providers: new Map([['haiku', haiku], ['opus', opus]]), catalog: fakeCatalog(), log: () => {} });
  const server = createJevServer({ router, providerIds: ['haiku', 'opus'], apiKey: 'secret' });
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' };

  it('requires the api key', async () => {
    const r = await fetch(`${base}/v1/models`);
    expect(r.status).toBe(401);
  });

  it('lists jev-auto plus providers', async () => {
    const r = await fetch(`${base}/v1/models`, { headers: auth });
    const j = await r.json();
    expect(j.data.map((m: { id: string }) => m.id)).toEqual(['jev-auto', 'haiku', 'opus']);
  });

  it('routes a chat completion', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'jev-auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.choices[0].message.content).toBe('echo:hi');
    expect(j.jev.assessment.source).toBe('heuristic');
    expect(r.headers.get('x-jev-provider')).toBe('haiku');
  });

  it('streams as SSE', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'opus', stream: true, messages: [{ role: 'user', content: 'yo' }] }),
    });
    const text = await r.text();
    expect(r.headers.get('content-type')).toMatch(/event-stream/);
    expect(text).toContain('"content":"echo:yo"');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('returns 409 for risky tasks unless approved', async () => {
    const strict = parseConfig({ ...cfg, classifier: { ...cfg.classifier, approvalRiskScore: 1.5 } });
    const r2 = new Router({ config: strict, providers: new Map([['haiku', haiku], ['opus', opus]]), catalog: fakeCatalog(), log: () => {} });
    const s2 = createJevServer({ router: r2, providerIds: ['haiku', 'opus'] });
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(s2.address() as AddressInfo).port}/v1/chat/completions`;
    const msg = { messages: [{ role: 'user', content: 'drop table users in production' }] };
    try {
      const denied = await fetch(url, { method: 'POST', body: JSON.stringify(msg) });
      expect(denied.status).toBe(409);
      expect((await denied.json()).jev.assessment.requireApproval).toBe(true);
      const ok = await fetch(url, { method: 'POST', body: JSON.stringify({ ...msg, jev: { approve: true } }) });
      expect(ok.status).toBe(200);
    } finally {
      await new Promise<void>((r) => s2.close(() => r()));
    }
  });

  it('decide endpoint returns a plan without executing', async () => {
    const before = haiku.calls.length + opus.calls.length;
    const r = await fetch(`${base}/v1/jev/decide`, { method: 'POST', headers: auth, body: JSON.stringify({ messages: [{ role: 'user', content: 'explain closures' }] }) });
    const j = await r.json();
    expect(j.plan.length).toBeGreaterThan(0);
    expect(haiku.calls.length + opus.calls.length).toBe(before);
  });

  it('accepts feedback', async () => {
    const r = await fetch(`${base}/v1/jev/feedback`, { method: 'POST', headers: auth, body: JSON.stringify({ providerId: 'haiku', effort: 'low', ok: false }) });
    expect(r.status).toBe(200);
    expect(router.outcomes.observations('haiku', 'low').fail).toBe(1);
  });

  it('400s on bad JSON', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: '{' });
    expect(r.status).toBe(400);
  });
});
