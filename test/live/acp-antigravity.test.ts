import { describe, expect, it } from 'vitest';
import { AcpProvider, findAntigravityAcpServer } from '../../src/providers/acp.js';

describe.skipIf(!process.env.JEV_LIVE || !findAntigravityAcpServer())('live: Antigravity over ACP (T3 bundled server)', () => {
  it('answers pong on gemini-3.8-flash-low', async () => {
    const p = new AcpProvider('agy', { kind: 'acp', preset: 'antigravity', model: 'gemini-3.8-flash-{effort}', billing: 'subscription', enabled: true } as any);
    const r = await p.complete({ messages: [{ role: 'user', content: 'Reply with exactly the single word: pong' }], effort: 'low', timeoutMs: 120_000 });
    expect(r.text.toLowerCase()).toContain('pong');
    expect(r.model).toBe('gemini-3.8-flash-low');
  }, 150_000);
});
