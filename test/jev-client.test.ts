import { describe, expect, it, vi } from 'vitest';
import { choice, JevClient, JevError, noul, score } from '../src/jev/index.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const questions = {
  tier: choice('Pick a tier', { fast: 'easy stuff', deep: 'hard stuff' }),
  risky: noul('Is this risky?'),
  risk: score('Rate risk', ['low', 'high']),
};

const okBody = {
  model: 'jev-1.13.0',
  answers: {
    tier: { type: 'choice', choice: 'deep', probabilities: { fast: 0.1, deep: 0.9 }, confidence: 0.85 },
    risky: { type: 'noul', noul: 0.2 },
    risk: { type: 'score', score: 0.3, legend: { '0': 'low', '1': 'high' }, probabilities: [0.7, 0.3], confidence: 0.6 },
  },
  usage: { input_tokens: 100, output_tokens: 10 },
};

describe('JevClient', () => {
  it('posts to {baseUrl}/systemone with bearer auth and pinned model', async () => {
    const fetch = vi.fn(async () => jsonResponse(okBody, 200, { 'x-cost-usd': '0.00001' }));
    const c = new JevClient({ baseUrl: 'https://x.test/v1/', apiKey: 'k', model: 'jev-1.13-free', fetch });
    const r = await c.systemOne({ state: 'hello', questions });
    expect(r.answers.tier.choice).toBe('deep');
    expect(r.costUsd).toBe(0.00001);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.test/v1/systemone');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe('jev-1.13-free');
    expect(sent.questions.risky).toEqual({ type: 'noul', instructions: 'Is this risky?' });
  });

  it('does not retry 4xx and surfaces retry-after', async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { message: 'limit' } }, 429, { 'retry-after': '60' }));
    const c = new JevClient({ baseUrl: 'https://x.test/v1', model: 'm', fetch, maxRetries: 3 });
    const err = await c.systemOne({ state: 's', questions }).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSec).toBe(60);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx then succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 503))
      .mockResolvedValueOnce(jsonResponse(okBody));
    const c = new JevClient({ baseUrl: 'https://x.test/v1', model: 'm', fetch, maxRetries: 1 });
    await expect(c.systemOne({ state: 's', questions })).resolves.toMatchObject({ model: 'jev-1.13.0' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('opens the circuit breaker after N failed calls', async () => {
    let t = 0;
    const fetch = vi.fn(async () => jsonResponse({}, 500));
    const c = new JevClient({
      baseUrl: 'https://x.test/v1', model: 'm', fetch, maxRetries: 0,
      circuitBreakerThreshold: 2, circuitBreakerCooldownMs: 1000, now: () => t,
    });
    await c.systemOne({ state: 's', questions }).catch(() => {});
    await c.systemOne({ state: 's', questions }).catch(() => {});
    expect(c.circuitOpen).toBe(true);
    await expect(c.systemOne({ state: 's', questions })).rejects.toThrow(/circuit breaker/);
    expect(fetch).toHaveBeenCalledTimes(2);
    t = 2000;
    expect(c.circuitOpen).toBe(false);
  });

  it('times out', async () => {
    const fetch = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, rej) => {
      init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    const c = new JevClient({ baseUrl: 'https://x.test/v1', model: 'm', fetch: fetch as any, timeoutMs: 20, maxRetries: 0 });
    await expect(c.systemOne({ state: 's', questions })).rejects.toThrow(/timed out/);
  });

  it('validates question builders', () => {
    expect(() => score('x', ['one'])).toThrow();
    expect(() => choice('x', {})).toThrow();
  });
});
