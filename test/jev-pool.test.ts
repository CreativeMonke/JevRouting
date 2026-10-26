import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { JevClient, JevPool, noul } from '../src/jev/index.js';
import { jevFromConfig } from '../src/router/engine.js';

const ok = (model: string) =>
  new Response(JSON.stringify({ model, answers: { q: { type: 'noul', noul: 0.9 } } }), { status: 200 });
const questions = { q: noul('Is it?') };

describe('JevClient workers-ai transport', () => {
  it('uses the Workers AI URL and unwraps the Cloudflare envelope', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { model: 'clef-flash', answers: { q: { type: 'noul', noul: 0.4 } } } }), { status: 200 }),
    );
    const c = new JevClient({ baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc', model: 'clef-flash', transport: 'workers-ai', fetch, apiKey: 't' });
    const r = await c.systemOne({ state: 's', questions });
    expect(r.answers.q.noul).toBe(0.4);
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/cloudflare/clef-flash');
  });

  it('stops calling a backend after 429 until Retry-After passes', async () => {
    let t = 0;
    const fetch = vi.fn(async () => new Response('{"error":{"message":"limit"}}', { status: 429, headers: { 'retry-after': '120' } }));
    const c = new JevClient({ baseUrl: 'https://x/v1', model: 'm', fetch, now: () => t });
    await expect(c.systemOne({ state: 's', questions })).rejects.toThrow(/429/);
    expect(c.circuitOpen).toBe(true);
    await expect(c.systemOne({ state: 's', questions })).rejects.toThrow(/rate limited/);
    expect(fetch).toHaveBeenCalledTimes(1);
    t = 121_000;
    expect(c.circuitOpen).toBe(false);
  });
});

describe('JevPool', () => {
  it('fails over in order and uses each backend’s own model', async () => {
    const a = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } }));
    const b = vi.fn(async (_u: string, init: RequestInit) => ok(JSON.parse(init.body as string).model));
    const pool = new JevPool([
      { name: 'zen', baseUrl: 'https://zen/v1', model: 'jev-1.13-free', fetch: a },
      { name: 'clef', baseUrl: 'https://cf/acc', model: 'clef-flash', transport: 'workers-ai', fetch: b as any },
    ]);
    const r = await pool.systemOne({ state: 's', questions });
    expect(r.model).toBe('clef-flash');
    // second call skips the rate-limited backend without a request
    await pool.systemOne({ state: 's', questions });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    expect(pool.model).toBe('clef-flash');
  });

  it('reports every backend error when all fail', async () => {
    const bad = vi.fn(async () => new Response('{"message":"down"}', { status: 503 }));
    const pool = new JevPool([
      { name: 'one', baseUrl: 'https://1', model: 'm', fetch: bad, maxRetries: 0 },
      { name: 'two', baseUrl: 'https://2', model: 'm', fetch: bad, maxRetries: 0 },
    ]);
    await expect(pool.systemOne({ state: 's', questions })).rejects.toThrow(/one: .*503.*two: .*503/);
  });
});

describe('jevFromConfig', () => {
  it('skips backends whose required env vars are unset', () => {
    const raw = {
      jev: {
        baseUrl: 'https://zen/v1', model: 'jev-1.13-free',
        backends: [
          { name: 'cf', transport: 'workers-ai', baseUrl: 'https://cf/accounts/${CF_ID}', model: 'clef-flash', requires: ['${CF_ID}'] },
          { name: 'ts', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-1.13.0', apiKey: '${TS_KEY}', requires: ['${TS_KEY}'] },
        ],
      },
      providers: { m: { kind: 'mock' } },
    };
    const none = jevFromConfig(parseConfig(raw, {})) as JevPool;
    expect(none.clients.map((c) => c.name)).toEqual(['primary']);
    const both = jevFromConfig(parseConfig(raw, { CF_ID: 'abc', TS_KEY: 'k' })) as JevPool;
    expect(both.clients.map((c) => c.name)).toEqual(['primary', 'cf', 'ts']);
  });
});
